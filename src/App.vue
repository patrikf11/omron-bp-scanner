<script setup>
import { ref, onMounted } from 'vue'

const THINGSPEAK_API_KEY = 'YOUR_WRITE_API_KEY'
const segmentMap = {
  "1111110": 0, "0110000": 1, "1101101": 2, "1111001": 3, "0110011": 4,
  "1011011": 5, "1011111": 6, "1110000": 7, "1111111": 8, "1111011": 9
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

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video.value, 0, 0);

  const src = cv.imread(tempCanvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  
  // 1. STRETCH CONTRAST
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  
  // 2. INVERTED THRESHOLD: Numbers become WHITE (255), Background becomes BLACK (0)
  // This solves the "All Black" issue by making the numbers the target.
  cv.threshold(gray, binary, 100, 255, cv.THRESH_BINARY_INV);

  // 3. NOISE REDUCTION: Remove tiny white speckles
  let M = cv.Mat.ones(2, 2, cv.CV_8U);
  cv.morphologyEx(binary, binary, cv.MORPH_OPEN, M);

  // 4. ROI SQUARE (Width 28%)
  const scanSize = binary.cols * 0.28;
  const roi = binary.roi(new cv.Rect((binary.cols - scanSize)/2, (binary.rows - scanSize)/2, scanSize, scanSize));

  // 5. FIND CONTOURS
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(roi, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let digitBoxes = [];
  for (let i = 0; i < contours.size(); ++i) {
    let rect = cv.boundingRect(contours.get(i));
    // Filter: Look for vertical rectangles that aren't too small
    if (rect.height > 20 && rect.height > rect.width) {
      digitBoxes.push(rect);
      // Draw a box around every detected digit
      cv.rectangle(roi, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), [255, 255, 255, 255], 1);
    }
  }

  // 6. Group by Row (SYS, DIA, PULSE)
  // Sort by Y-coordinate
  digitBoxes.sort((a, b) => a.y - b.y);

  const parseDigit = (rect) => {
    const { x, y, width: dW, height: dH } = rect;
    // Sensor points (since numbers are now WHITE, we check for val > 128)
    const pts = [
      {x: dW/2, y: dH*0.1}, {x: dW*0.9, y: dH*0.25}, {x: dW*0.9, y: dH*0.75},
      {x: dW/2, y: dH*0.9}, {x: dW*0.1, y: dH*0.75}, {x: dW*0.1, y: dH*0.25},
      {x: dW/2, y: dH/2}
    ];
    const bits = pts.map(pt => {
      const pxX = Math.round(x + pt.x), pxY = Math.round(y + pt.y);
      if (pxY >= roi.rows || pxX >= roi.cols) return "0";
      return roi.ucharAt(pxY, pxX) > 128 ? "1" : "0"; 
    }).join("");
    return segmentMap[bits] ?? "";
  };

  // Logic: 1st row usually has 3 digits, 2nd has 3, 3rd has 2 or 3
  const results = digitBoxes.map(box => parseDigit(box)).join("");
  readings.value.sys = results.substring(0, 3);
  readings.value.dia = results.substring(3, 6);
  readings.value.pulse = results.substring(6);

  cv.imshow(debugCanvas.value, roi);

  // Cleanup
  src.delete(); gray.delete(); binary.delete(); roi.delete(); 
  contours.delete(); hierarchy.delete(); M.delete();
};

//
const processFrameOld = () => {
  const cv = window.cv;
  if (!video.value || video.value.readyState < 2 || video.value.paused) return;

  // 1. Capture to Temp Canvas
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video.value, 0, 0);

  // 2. Load into OpenCV & Pre-process
  const src = cv.imread(tempCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  
  // High contrast for grey LCD
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  cv.threshold(gray, gray, 110, 255, cv.THRESH_BINARY); 

  // 3. Define Square ROI (50% of width)
  const vW = gray.cols;
  const vH = gray.rows;
  const scanSize = vW * 0.28; 
  const startX = (vW - scanSize) / 2;
  const startY = (vH - scanSize) / 2;
  
  const roi = gray.roi(new cv.Rect(startX, startY, scanSize, scanSize));
  const w = scanSize;
  const h = scanSize;

  // 4. Proportions (37% / 38% / 25%)
  const sysRowH = h * 0.37;
  const diaRowH = h * 0.38;
  const pulseRowH = h * 0.25;
  const dW = w * 0.22; // Slot width
  const dH = h * 0.20; // Slot height

  const getDigit = (col, row) => {
    // Horizontal spacing
    const dX = Math.round((w * 0.15) + (col * dW * 1.3));
    
    // Vertical spacing logic
    let dY = 0;
    if (row === 0) dY = Math.round(sysRowH * 0.1);
    else if (row === 1) dY = Math.round(sysRowH + (diaRowH * 0.1));
    else dY = Math.round(sysRowH + diaRowH + (pulseRowH * 0.1));
    
    // Draw guide box for user
    cv.rectangle(roi, new cv.Point(dX, dY), new cv.Point(dX + dW, dY + dH), new cv.Scalar(180), 1);

    // 7 Sensors
    const pts = [
      {x: dW/2, y: dH*0.15}, {x: dW*0.8, y: dH*0.3}, {x: dW*0.8, y: dH*0.7},
      {x: dW/2, y: dH*0.85}, {x: dW*0.2, y: dH*0.7}, {x: dW*0.2, y: dH*0.3},
      {x: dW/2, y: dH/2}
    ];

    const bits = pts.map(pt => {
      const pxX = Math.round(dX + pt.x), pxY = Math.round(dY + pt.y);
      if (pxY >= roi.rows || pxX >= roi.cols) return "0";
      
      let darkCount = 0;
      for(let i=-1; i<=1; i++){
        for(let j=-1; j<=1; j++){
          if (roi.ucharAt(pxY+i, pxX+j) < 120) darkCount++;
        }
      }
      // Visible red-style dots in debug
      cv.circle(roi, new cv.Point(pxX, pxY), 1, new cv.Scalar(255), -1);
      return darkCount >= 5 ? "1" : "0";
    }).join("");

    return segmentMap[bits] ?? "";
  };

  // 5. Update Readings
  readings.value.sys = `${getDigit(0, 0)}${getDigit(1, 0)}${getDigit(2, 0)}`;
  readings.value.dia = `${getDigit(0, 1)}${getDigit(1, 1)}${getDigit(2, 1)}`;
  readings.value.pulse = `${getDigit(0, 2)}${getDigit(1, 2)}${getDigit(2, 2)}`;

  // 6. Show Debug & Cleanup (VERY IMPORTANT to delete Mats)
  cv.imshow(debugCanvas.value, roi);
  src.delete(); gray.delete(); roi.delete();
};
</script>


<template>
  <div class="app">
    <h3>Omron M3 OpenCV PWA dyn</h3>
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
