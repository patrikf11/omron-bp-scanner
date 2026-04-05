<script setup>
import { ref, onMounted } from 'vue'
import * as ScannerService from '@/services/omronScanner';

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
  if (!isLive.value ) return;
  if (!isProcessing.value) {
    processFrame(); 
  }
  setTimeout(runLoop, 250); 
};

// opencv can do this but for some reason it didnt work on my iphone
const tempCanvas = document.createElement('canvas');
const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
const captureToCanvas = () => {
  if (!video.value || video.value.readyState < 2) return null;
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  tempCtx.drawImage(video.value, 0, 0);
  return tempCanvas;
}

const isProcessing = ref(false);
const processFrame = () => {
  const cv = window.cv;
  if (!cv || isProcessing.value) return;

  const canvas = captureToCanvas();
  if (!canvas || canvas.width === 0) return;

  isProcessing.value = true;

  const { roi, digitBoxes, scanSize } = ScannerService.prepareScanner(cv, canvas);
  const results = ScannerService.getReadings(cv, roi, digitBoxes, scanSize);
  
  if (results.sys || results.dia) {
    readings.value = results;
    status.value = "Scanning...";
  }

  //debug
  cv.imshow(debugCanvas.value, roi);

  // 6. CLEANUP
  roi.delete(); 
  isProcessing.value = false; 
};
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
