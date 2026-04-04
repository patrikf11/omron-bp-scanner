<script setup>
import { ref, onMounted } from 'vue'

const THINGSPEAK_API_KEY = 'YOUR_WRITE_API_KEY'
const segmentMap = {
  "1111110": 0, 
  "0110000": 1, // Traditional 1 (TR, BR)
  "0010000": 1, // Faint 1 (Only BR)
  "0100000": 1, 
  "1101101": 2, 
  "1111001": 3, 
  "0110011": 4,
  "1011011": 5, 
  "1011111": 6, 
  "1110000": 7, 
  "1111111": 8, 
  "1111011": 9
}

const video = ref(null)
const debugCanvas = ref(null)
const status = ref('Loading OpenCV...')
const readings = ref({ sys: '', dia: '', pulse: '' })
const cvReady = ref(false)
const isLive = ref(false)

onMounted(() => {
  const checkCV = setInterval(() => {
    if (window.cv && typeof window.cv.Mat === 'function') {
      clearInterval(checkCV)
      cvReady.value = true
      status.value = 'Ready. Align Omron in Square.'
      startCamera()
    }
  }, 500)
})

const startCamera = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ 
    video: { facingMode: 'environment', focusMode: 'continuous' } 
  })
  video.value.srcObject = stream
}

const toggleLive = () => {
  isLive.value = !isLive.value
  if (isLive.value) runLoop()
}

const runLoop = () => {
  if (!isLive.value) return
  processFrame()
  requestAnimationFrame(runLoop)
}
//
const processFrame = () => {
  const cv = window.cv;
  if (!video.value || video.value.readyState < 2) return;

  // 1. Precise Image Capture
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video.value, 0, 0);

  const src = cv.imread(tempCanvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
   
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);

  // 1. ADAPTIVE THRESHOLD (Keep it strict)
  cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 15);

  const scanSize = binary.cols * 0.28;
  const roi = binary.roi(new cv.Rect((binary.cols - scanSize)/2, (binary.rows - scanSize)/2, scanSize, scanSize));

  // 2. DILATION: Fatten the black segments so they touch
  // This turns a "broken" 8 into a solid 8
  let M = cv.Mat.ones(2, 2, cv.CV_8U);
  let inverted = new cv.Mat();
  cv.bitwise_not(roi, inverted); // Invert so digits are white for dilation
  cv.dilate(inverted, inverted, M);

  // 3. FIND CONTOURS on the "fattened" digits
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(inverted, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let digitBoxes = [];
  for (let i = 0; i < contours.size(); ++i) {
    let rect = cv.boundingRect(contours.get(i));
    // 4. RELAXED FILTER: Accept thinner (the "1") and smaller digits
    if (rect.height > 15 && rect.height < (scanSize * 0.5)) {
      digitBoxes.push(rect);
      cv.rectangle(roi, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), new cv.Scalar(150), 1);
    }
  }
//merge adjacent vertical boxes
let mergedBoxes = [];
  digitBoxes.sort((a, b) => a.x - b.x); // Sort left-to-right to find neighbors

  for (let i = 0; i < digitBoxes.length; i++) {
    let current = digitBoxes[i];
    let merged = false;

    for (let j = 0; j < mergedBoxes.length; j++) {
      let prev = mergedBoxes[j];
      
      // Check if they are horizontally aligned (same X) and vertically close
      const horizontalOverlap = Math.abs(current.x - prev.x) < (scanSize * 0.05);
      const verticalGap = current.y - (prev.y + prev.height);

      if (horizontalOverlap && verticalGap < (current.height * 1.5)) {
        // Merge the two boxes into one tall one
        prev.y = Math.min(prev.y, current.y);
        prev.height = Math.max(prev.y + prev.height, current.y + current.height) - prev.y;
        prev.width = Math.max(prev.width, current.width);
        merged = true;
        break;
      }
    }
    if (!merged) mergedBoxes.push(current);
  }
  // Now use mergedBoxes for the rest of your row grouping
  digitBoxes = mergedBoxes;


  // 5. ROW GROUPING (SYS/DIA/PULSE)
  // Group digits into 3 rows based on their Y coordinate
  const rowThreshold = scanSize * 0.25; 
  let sysGroup = [], diaGroup = [], pulGroup = [];

  digitBoxes.forEach(box => {
    if (box.y < rowThreshold) sysGroup.push(box);
    else if (box.y < rowThreshold * 2.2) diaGroup.push(box);
    else pulGroup.push(box);
  });

  // Sort each row Left-to-Right
  const sortX = (a, b) => a.x - b.x;
  sysGroup.sort(sortX); diaGroup.sort(sortX); pulGroup.sort(sortX);

  const parse = (box) => {
    // Check segments in the original ROI (which isn't dilated)
    const { x, y, width: dW, height: dH } = box;
    const pts = [
      {x: dW/2, y: dH*0.15}, {x: dW*0.85, y: dH*0.3}, {x: dW*0.85, y: dH*0.7},
      {x: dW/2, y: dH*0.85}, {x: dW*0.15, y: dH*0.7}, {x: dW*0.15, y: dH*0.3},
      {x: dW/2, y: dH/2}
    ];
    const bits = pts.map(pt => roi.ucharAt(Math.round(y + pt.y), Math.round(x + pt.x)) < 120 ? "1" : "0").join("");
    return segmentMap[bits] ?? "";
  };

  readings.value.sys = sysGroup.map(parse).join("");
  readings.value.dia = diaGroup.map(parse).join("");
  readings.value.pulse = pulGroup.map(parse).join("");

  cv.imshow(debugCanvas.value, roi);

  // 6. CLEANUP
  src.delete(); gray.delete(); binary.delete(); roi.delete(); 
  inverted.delete(); contours.delete(); hierarchy.delete(); M.delete();
};

//
const processFramed1 = () => {
  const cv = window.cv;
  if (!video.value || video.value.readyState < 2) return;

  // 1. Precise Image Capture
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video.value, 0, 0);

  const src = cv.imread(tempCanvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  
  // 2. CONVERT & ENHANCE CONTRAST
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  
  // Stretch the grey levels to the absolute max/min
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);

  // 3. SMOOTHING (Removes the "speckles")
  // Blurring slightly helps join the 7-segments into solid shapes
  let ksize = new cv.Size(3, 3);
  cv.GaussianBlur(gray, gray, ksize, 0, 0, cv.BORDER_DEFAULT);

  // 4. ADAPTIVE THRESHOLD (The "Speckle Killer")
  // We use THRESH_BINARY (not INV) so digits stay BLACK on WHITE for the debug view.
  // The '15' at the end is the 'C' constant. Increase it (e.g., 20 or 25) to make it "whiter".
  cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 15);

  // 5. SQUARE ROI (Width 28%)
  const scanSize = binary.cols * 0.28;
  const roi = binary.roi(new cv.Rect((binary.cols - scanSize)/2, (binary.rows - scanSize)/2, scanSize, scanSize));

  // 6. FIND CONTOURS (Looking for the BLACK digits)
  // findContours works best on WHITE objects, so we temporarily INVERT for the logic
  let inverted = new cv.Mat();
  cv.bitwise_not(roi, inverted);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(inverted, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let digitBoxes = [];
  for (let i = 0; i < contours.size(); ++i) {
    let rect = cv.boundingRect(contours.get(i));
    // Filter: Omron digits are taller than they are wide.
    if (rect.height > 20 && rect.height > rect.width) {
      digitBoxes.push(rect);
      // Draw a box around detected digits in the ROI
      cv.rectangle(roi, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), [100, 100, 100, 255], 1);
    }
  }
  //merge adjacent vertical boxes
  let mergedBoxes = [];
  digitBoxes.sort((a, b) => a.x - b.x); // Sort left-to-right to find neighbors

  for (let i = 0; i < digitBoxes.length; i++) {
    let current = digitBoxes[i];
    let merged = false;

    for (let j = 0; j < mergedBoxes.length; j++) {
      let prev = mergedBoxes[j];
      
      // Check if they are horizontally aligned (same X) and vertically close
      const horizontalOverlap = Math.abs(current.x - prev.x) < (scanSize * 0.05);
      const verticalGap = current.y - (prev.y + prev.height);

      if (horizontalOverlap && verticalGap < (current.height * 1.5)) {
        // Merge the two boxes into one tall one
        prev.y = Math.min(prev.y, current.y);
        prev.height = Math.max(prev.y + prev.height, current.y + current.height) - prev.y;
        prev.width = Math.max(prev.width, current.width);
        merged = true;
        break;
      }
    }
    if (!merged) mergedBoxes.push(current);
  }
  // Now use mergedBoxes for the rest of your row grouping
  digitBoxes = mergedBoxes;




  // 7. Sort and Parse
  digitBoxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const results = digitBoxes.map(box => {
    // Check segments within this box in 'roi' (Black digits on white)
    const { x, y, width: dW, height: dH } = box;
    const pts = [
      {x: dW/2, y: dH*0.1}, {x: dW*0.9, y: dH*0.25}, {x: dW*0.9, y: dH*0.75},
      {x: dW/2, y: dH*0.9}, {x: dW*0.1, y: dH*0.75}, {x: dW*0.1, y: dH*0.25},
      {x: dW/2, y: dH*0.5}
    ];
    const bits = pts.map(pt => roi.ucharAt(Math.round(y + pt.y), Math.round(x + pt.x)) < 128 ? "1" : "0").join("");
    return segmentMap[bits] ?? "";
  }).join("");

  readings.value.sys = results.substring(0, 3);
  readings.value.dia = results.substring(3, 6);
  readings.value.pulse = results.substring(6);

  cv.imshow(debugCanvas.value, roi);

  // 8. CLEANUP
  src.delete(); gray.delete(); binary.delete(); roi.delete(); inverted.delete();
  contours.delete(); hierarchy.delete();
};

</script>


<template>
  <div class="app">
    <h3>Omron M3 OpenCV PWA reco 1</h3>
    <div class="video-container">
      <video ref="video" autoplay playsinline></video>
      <div class="scan-overlay"></div>
    </div>
    <div class="ui">
      <p class="status">{{ status }}</p>
      <button @click="toggleLive" :disabled="!cvReady" :class="isLive ? 'btn-stop' : 'btn-start'">
        {{ isLive ? 'STOP ALIGNMENT' : 'START LIVE VIEW' }}
      </button>
      <div v-if="readings.sys" class="results">
        <div class="row">SYS: {{ readings.sys }} | DIA: {{ readings.dia }} | PUL: {{ readings.pulse }}</div>
        <button @click="saveToCloud" class="btn-cloud">SEND TO THINGSPEAK</button>
      </div>
      <div class="debug">
        <p>Debug (37/38/25 Split):</p>
        <canvas ref="debugCanvas"></canvas>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app { font-family: sans-serif; text-align: center; max-width: 450px; margin: auto; padding: 10px; }
.video-container { position: relative; border-radius: 12px; overflow: hidden; background: #000; }
video { width: 100%; display: block; }
.scan-overlay { 
  position: absolute; 
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%); /* Perfectly centers the square */
  
  width: 28vw;             /* Use 50% of the screen width */
  aspect-ratio: 1 / 1;     /* Force it to be a square */
  
  border: 2px solid #00ff00; 
  box-shadow: 0 0 0 1000px rgba(0,0,0,0.6);
  pointer-events: none;
}
.ui { margin-top: 10px; }
button { width: 100%; padding: 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
.btn-start { background: #3b82f6; color: white; }
.btn-stop { background: #ef4444; color: white; }
.btn-cloud { background: #10b981; color: white; margin-top: 8px; }
.results { margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px; }
.row { font-size: 1.2rem; font-weight: bold; margin-bottom: 8px; }
canvas { width: 100%; margin-top: 8px; border: 1px solid #ccc; background: #000; border-radius: 6px; }
.status { color: #3b82f6; font-size: 0.9rem; min-height: 1.2rem; }
</style>
