<script setup>
import { ref, onMounted } from 'vue'

const THINGSPEAK_API_KEY = 'YOUR_WRITE_API_KEY' // <--- Set your key here
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
      status.value = 'Ready. Hold 30cm from Omron.'
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

const processFrame = () => {
  const cv = window.cv;
  // 1. Check if video is ready
  if (!video.value || video.value.readyState < 2 || video.value.paused) return;

  // 2. CAPTURE frame to temporary canvas (Fixes black/frozen frames on mobile)
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video.value, 0, 0);

  // 3. LOAD into OpenCV
  const src = cv.imread(tempCanvas);
  const gray = new cv.Mat();
  
  // 4. PRE-PROCESS for Grey Distinction
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  
  // Stretch contrast: makes background white and segments dark
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  
  // Manual Threshold: adjust 120 if too dark/light
  cv.threshold(gray, gray, 120, 255, cv.THRESH_BINARY); 

  // 5. DEFINE 30cm ROI (45% Wide, 35% High)
  const w = gray.cols * 0.45;
  const h = gray.rows * 0.35;
  const roi = gray.roi(new cv.Rect(gray.cols * 0.275, gray.rows * 0.325, w, h));

  // 6. ROW DIMENSIONS (37/38/25)
  const sysRowH = h * 0.37;
  const diaRowH = h * 0.38;
  const pulseRowH = h * 0.25;
  const dW = w * 0.20;
  const dH = h * 0.20;

  const getDigit = (col, row) => {
    const dX = Math.round((w * 0.12) + (col * dW * 1.15));
    let dY = 0;
    if (row === 0) dY = Math.round(sysRowH * 0.1);
    else if (row === 1) dY = Math.round(sysRowH + (diaRowH * 0.1));
    else dY = Math.round(sysRowH + diaRowH + (pulseRowH * 0.1));
    
    // Draw guide box
    cv.rectangle(roi, new cv.Point(dX, dY), new cv.Point(dX + dW, dY + dH), new cv.Scalar(180), 1);

    const pts = [
      {x: dW/2, y: dH*0.15}, {x: dW*0.85, y: dH*0.3}, {x: dW*0.85, y: dH*0.7},
      {x: dW/2, y: dH*0.85}, {x: dW*0.15, y: dH*0.7}, {x: dW*0.15, y: dH*0.3},
      {x: dW/2, y: dH/2}
    ];

    const bits = pts.map(pt => {
      const pxX = Math.round(dX + pt.x), pxY = Math.round(dY + pt.y);
      if (pxY >= roi.rows || pxX >= roi.cols) return "0";
      
      let darkCount = 0;
      for(let i=-1; i<=1; i++){
        for(let j=-1; j<=1; j++){
          // Check pixel value. If < 100, it's a dark segment.
          if (roi.ucharAt(pxY+i, pxX+j) < 100) darkCount++;
        }
      }
      cv.circle(roi, new cv.Point(pxX, pxY), 1, new cv.Scalar(255), -1);
      return darkCount >= 5 ? "1" : "0";
    }).join("");

    return segmentMap[bits] ?? "";
  };

  // 7. EXTRACT READINGS
  readings.value.sys = `${getDigit(0,0)}${getDigit(1,0)}${getDigit(2,0)}`;
  readings.value.dia = `${getDigit(0,1)}${getDigit(1,1)}${getDigit(2,1)}`;
  readings.value.pulse = `${getDigit(0,2)}${getDigit(1,2)}${getDigit(2,2)}`;

  // 8. SHOW OUTPUT & CLEANUP
  cv.imshow(debugCanvas.value, roi);
  src.delete(); gray.delete(); roi.delete();
};

//
const processFramebad = () => {
  const cv = window.cv
  if (!video.value || video.value.readyState < 2 || video.value.paused) return

  // Capture frame
  const tempCanvas = document.createElement('canvas')
  tempCanvas.width = video.value.videoWidth
  tempCanvas.height = video.value.videoHeight
  const tempCtx = tempCanvas.getContext('2d')
  tempCtx.drawImage(video.value, 0, 0)

  const src = cv.imread(tempCanvas)
  const gray = new cv.Mat()
  const binary = new cv.Mat()
  
  // 1. Pre-process (Grayscale + Auto Threshold)
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)

  // 2. 30cm ROI (45% Wide, 35% High) - This forces user to stay back
  const w = binary.cols * 0.45
  const h = binary.rows * 0.35
  const roi = binary.roi(new cv.Rect(binary.cols * 0.275, binary.rows * 0.325, w, h))

  // 3. Row Splits (37/38/25)
  const sysRowH = h * 0.37
  const diaRowH = h * 0.38
  const pulseRowH = h * 0.25
  const dW = w * 0.20 // Digit slot width
  const dH = h * 0.20 // Digit slot height

  const getDigit = (col, row) => {
    const dX = Math.round((w * 0.12) + (col * dW * 1.15))
    let dY = 0
    if (row === 0) dY = Math.round(sysRowH * 0.1)
    else if (row === 1) dY = Math.round(sysRowH + (diaRowH * 0.1))
    else dY = Math.round(sysRowH + diaRowH + (pulseRowH * 0.1))
    
    // Draw sensor boxes on debug view
    cv.rectangle(roi, new cv.Point(dX, dY), new cv.Point(dX + dW, dY + dH), new cv.Scalar(180), 1)

    // 7 Sensors mapped for 30cm focus
    const pts = [
      {x: dW/2, y: dH*0.15}, {x: dW*0.85, y: dH*0.3}, {x: dW*0.85, y: dH*0.7},
      {x: dW/2, y: dH*0.85}, {x: dW*0.15, y: dH*0.7}, {x: dW*0.15, y: dH*0.3},
      {x: dW/2, y: dH/2}
    ]

    const bits = pts.map(pt => {
      const pxX = Math.round(dX + pt.x), pxY = Math.round(dY + pt.y)
      if (pxY >= roi.rows || pxX >= roi.cols) return "0"
      
      // Area sample for stability (3x3 pixels)
      let darkCount = 0
      for(let i=-1; i<=1; i++){
        for(let j=-1; j<=1; j++){
          if (roi.ucharAt(pxY+i, pxX+j) < 120) darkCount++
        }
      }
      cv.circle(roi, new cv.Point(pxX, pxY), 1, new cv.Scalar(255), -1)
      return darkCount >= 5 ? "1" : "0"
    }).join("")

    return segmentMap[bits] ?? ""
  }

  // Extract Readings
  readings.value.sys = `${getDigit(0,0)}${getDigit(1,0)}${getDigit(2,0)}`
  readings.value.dia = `${getDigit(0,1)}${getDigit(1,1)}${getDigit(2,1)}`
  readings.value.pulse = `${getDigit(0,2)}${getDigit(1,2)}${getDigit(2,2)}`

  cv.imshow(debugCanvas.value, roi)
  src.delete(); gray.delete(); binary.delete(); roi.delete()
}

const saveToCloud = async () => {
  status.value = "Uploading..."
  const { sys, dia, pulse } = readings.value
  //const url = `https://thingspeak.com{THINGSPEAK_API_KEY}&field1=${sys}&field2=${dia}&field3=${pulse}`
  try {
    //const res = await fetch(url)
    if(res.ok) {
      status.value = "Saved!"
      if (navigator.vibrate) navigator.vibrate(200)
    }
  } catch { status.value = "Error!" }
}
</script>

<template>
  <div class="app">
    <h3>Omron M3 OpenCV PWA</h3>
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
  position: absolute; top: 32.5%; bottom: 32.5%; left: 27.5%; right: 27.5%; 
  border: 2px solid #00ff00; pointer-events: none;
  box-shadow: 0 0 0 1000px rgba(0,0,0,0.6);
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
