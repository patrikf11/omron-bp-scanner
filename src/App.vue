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
      status.value = 'OpenCV Loaded. Start Live View.'
      startCamera()
    }
  }, 500)
})

const startCamera = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ 
    video: { facingMode: 'environment' } 
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
  // 1. SAFETY CHECK: Ensure video is actually playing and has data
  if (!video.value || video.value.readyState < 2 || video.value.paused || video.value.ended) return;

  // Use a temporary canvas to 'capture' the frame first
  // This is often more reliable than reading the video element directly.
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video.value, 0, 0);



  const src = cv.imread(tempCanvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  
  // 2. CONVERT TO GRAYSCALE
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  cv.threshold(gray, gray, 80, 255, cv.THRESH_BINARY);
  //cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

  // 4. DEFINE ROI (Center Window)
  const w = binary.cols * 0.5, h = binary.rows * 0.5;
  const roi = binary.roi(new cv.Rect(binary.cols * 0.25, binary.rows * 0.25, w, h));

  // 5. DIGIT ANALYSIS
  /** */
  const dW = w * 0.16; // Narrower slots to avoid touching neighboring digits
  const dH = h * 0.22;
  
  const getDigit = (col, row) => {
    // Positioning the 3x3 grid of digits
    const getDigit = (col, row) => {
  // 1. Positioning the digit slots
  const dX = Math.round((w * 0.18) + (col * dW * 1.2)); 
  const dY = Math.round((h * 0.12) + (row * h * 0.30));
  
  // 2. The 7 sensors (a-g) shifted inward to avoid "bleeding" edges
  const pts = [
    {x: dW/2, y: dH*0.15}, // a: top
    {x: dW*0.8, y: dH*0.3},  // b: top-right
    {x: dW*0.8, y: dH*0.7},  // c: bottom-right
    {x: dW/2, y: dH*0.85}, // d: bottom
    {x: dW*0.2, y: dH*0.7},  // e: bottom-left
    {x: dW*0.2, y: dH*0.3},  // f: top-left
    {x: dW/2, y: dH/2}      // g: middle
  ];

  const bits = pts.map(pt => {
    const pxY = Math.round(dY + pt.y);
    const pxX = Math.round(dX + pt.x);
    
    // Safety check for ROI boundaries
    if (pxY < 0 || pxY >= roi.rows || pxX < 0 || pxX >= roi.cols) return "0";

    // Draw the sensor dot on the debug view for you to see
    cv.circle(roi, new cv.Point(pxX, pxY), 1, new cv.Scalar(255), -1);

    // 3. 3x3 AREA SAMPLE: Only trigger "1" if at least 5 pixels in the block are dark
    let darkCount = 0;
    for(let i = -1; i <= 1; i++) {
      for(let j = -1; j <= 1; j++) {
        // Checking pixel at (y+i, x+j). 100 is the dark-grey threshold.
        if (roi.ucharAt(pxY + i, pxX + j) < 100) darkCount++;
      }
    }
    
    return darkCount >= 5 ? "1" : "0"; 
  }).join("");

  // 4. Return the digit from the map, or empty string if it doesn't match
  return segmentMap[bits] ?? "";
};

  /** */

  // EXTRACT READINGS
  readings.value.sys = `${getDigit(0, 0)}${getDigit(1, 0)}${getDigit(2, 0)}`;
  readings.value.dia = `${getDigit(0, 1)}${getDigit(1, 1)}${getDigit(2, 1)}`;
  readings.value.pulse = `${getDigit(0, 2)}${getDigit(1, 2)}${getDigit(2, 2)}`;

  // SHOW OUTPUT
  cv.imshow(debugCanvas.value, roi);

  // CLEANUP (Crucial for mobile memory)
  src.delete(); gray.delete(); binary.delete(); roi.delete();
};


const saveToCloud = async () => {
  status.value = "Uploading..."
  const { sys, dia, pulse } = readings.value
  //const url = `https://thingspeak.com{THINGSPEAK_API_KEY}&field1=${sys}&field2=${dia}&field3=${pulse}`
  try {
    //await fetch(url)
    status.value = "Saved to ThingSpeak!"
    if (navigator.vibrate) navigator.vibrate(200)
  } catch {
    status.value = "Upload failed."
  }
}
</script>

<template>
  <div class="app">
    <h2>Omron M3 OpenCV PWA live4</h2>
    
    <div class="video-container">
      <video ref="video" autoplay playsinline></video>
      <div class="scan-overlay"></div>
    </div>

    <div class="ui">
      <p class="status">{{ status }}</p>
      
      <button @click="toggleLive" :disabled="!cvReady" :class="isLive ? 'btn-stop' : 'btn-start'">
        {{ isLive ? 'STOP LIVE VIEW' : 'START LIVE ALIGNMENT' }}
      </button>

      <div v-if="readings.sys" class="results">
        <div class="reading-row">SYS: {{ readings.sys }} | DIA: {{ readings.dia }} | PUL: {{ readings.pulse }}</div>
        <button @click="saveToCloud" class="btn-cloud">SEND TO THINGSPEAK</button>
      </div>

      <div class="debug-area">
        <p>Real-time Dot Check:</p>
        <canvas ref="debugCanvas"></canvas>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app { font-family: sans-serif; text-align: center; padding: 10px; max-width: 500px; margin: auto; }
.video-container { position: relative; border-radius: 15px; overflow: hidden; background: #000; }
video { width: 100%; display: block; }
.scan-overlay { 
  position: absolute; top: 25%; left: 25%; right: 25%; bottom: 25%; 
  border: 2px solid #00ff00; pointer-events: none;
  box-shadow: 0 0 0 1000px rgba(0,0,0,0.5);
}
.ui { margin-top: 10px; }
button { width: 100%; padding: 15px; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; transition: 0.3s; }
.btn-start { background: #3b82f6; color: white; }
.btn-stop { background: #ef4444; color: white; }
.btn-cloud { background: #10b981; color: white; margin-top: 10px; }
.results { margin-top: 15px; padding: 15px; background: #f3f4f6; border-radius: 10px; border: 1px solid #ddd; }
.reading-row { font-size: 1.2rem; font-weight: bold; margin-bottom: 10px; }
canvas { width: 100%; margin-top: 10px; border: 1px solid #ccc; background: #000; border-radius: 8px; }
.status { color: #3b82f6; font-size: 0.9rem; margin-bottom: 10px; min-height: 1.2rem; }
</style>
