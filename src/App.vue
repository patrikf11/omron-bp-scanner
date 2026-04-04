<script setup>
import { ref, onMounted } from 'vue'

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

const runLoop = async () => {
  if (!isLive.value) return;

  // 1. Only run if we aren't already busy with a scan
  if (!isProcessing.value) {
    await processFrame(); 
  }

  // 2. Wait 500ms before trying the next scan
  // This is fast enough to feel "live" but slow enough to be stable
  setTimeout(runLoop, 500); 
};
/*
const runLoop = () => {
  if (!isLive.value) return
  processFrame()
  requestAnimationFrame(runLoop)
}
*/
const isProcessing = ref(false);
const processFrame = async () => {
  const cv = window.cv;
  if (!video.value || video.value.readyState < 2) return;

  isProcessing.value = true;
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

  // going back to segmented 
  const parseDigitBox = (rect) => {
  const { x, y, width: dW, height: dH } = rect;
  
  // 1. Extract the digit and ensure segments are WHITE for countNonZero
  let digitMat = roi.roi(rect);

  // 2. Define the 7 segments as relative boxes [x, y, width, height]
  // These are percentages (0.0 to 1.0) of the bounding box
  const segments = [
    [0.2, 0.05, 0.6, 0.1],  // Top (A)
    [0.75, 0.1, 0.2, 0.35], // Upper Right (B)
    [0.75, 0.55, 0.2, 0.35],// Lower Right (C)
    [0.2, 0.85, 0.6, 0.1],  // Bottom (D)
    [0.05, 0.55, 0.2, 0.35],// Lower Left (E)
    [0.05, 0.1, 0.2, 0.35], // Upper Left (F)
    [0.2, 0.45, 0.6, 0.1]   // Middle (G)
  ];

  // 3. Count pixels in each segment box
  const active = segments.map(([sX, sY, sW, sH]) => {
    const segRect = new cv.Rect(sX * dW, sY * dH, sW * dW, sH * dH);
    const segRoi = digitMat.roi(segRect);
    
    const onPixels = cv.countNonZero(segRoi);
    const totalPixels = segRect.width * segRect.height;
    
    segRoi.delete();
    // Threshold: if > 30% of pixels in this zone are white, segment is ON
    return (onPixels / totalPixels > 0.3) ? 1 : 0;
  });

  // 4. Map the bitmask to a digit
  const mask = active.join("");
  const lookup = {
    "1111110": "0", "0110000": "1", "1101101": "2", "1111001": "3", "0110011": "4",
    "1011011": "5", "1011111": "6", "1110000": "7", "1111111": "8", "1111011": "9"
  };

  const result = lookup[mask] || ""; // Returns empty string if no match found

  // 5. Visual Debug: Draw the result on your ROI canvas
  cv.putText(roi, result, new cv.Point(x, y - 5), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(255), 1);
  
  digitMat.delete();
  return result;
};

  // Add this right before the digitBoxes.map(parseDigitBox) line
  let kernel = cv.Mat.ones(2, 2, cv.CV_8U);
  cv.erode(roi, roi, kernel); 
  kernel.delete();

  cv.imshow(debugCanvas.value, roi);
  
  readings.value.sys = sysGroup.map(parseDigitBox).join("");
  readings.value.dia = diaGroup.map(parseDigitBox).join("");
  readings.value.pulse = pulGroup.map(parseDigitBox).join("");

  isProcessing.value = false; // Unlock for the next frame

  // 6. CLEANUP
  src.delete(); gray.delete(); binary.delete(); roi.delete(); 
  inverted.delete(); contours.delete(); hierarchy.delete(); M.delete();
};

</script>


<template>
  <div class="app">
    <h3>Omron M3 OpenCV PWA tesseract</h3>
    <div class="video-container">
      <video ref="video" autoplay playsinline></video>
      <div class="scan-overlay"></div>
    </div>
    <div class="ui">
      <p class="status">{{ status }}</p>
      <button @click="toggleLive" :disabled="!cvReady" :class="isLive ? 'btn-stop' : 'btn-start'">
        {{ isLive ? 'STOP ALIGNMENT' : 'START LIVE VIEW' }}
      </button>
      <div class="row">SYS: {{ readings.sys }} | DIA: {{ readings.dia }} | PUL: {{ readings.pulse }}</div>
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
