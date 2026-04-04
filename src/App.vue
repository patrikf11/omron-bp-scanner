<script setup>
import { ref, onMounted } from 'vue'

// --- CONFIGURATION ---
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

onMounted(() => {
  const checkCV = setInterval(() => {
    // Check for both the global variable AND the internal Mat constructor
    if (window.cv && typeof window.cv.Mat === 'function') {
      clearInterval(checkCV);
      cvReady.value = true;
      status.value = 'OpenCV Loaded! Ready to scan.';
      startCamera();
    } else {
      status.value = 'Downloading OpenCV (10MB)...';
    }
  }, 500); // Check every half second
});


const startCamera = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ 
    video: { facingMode: 'environment' } 
  })
  video.value.srcObject = stream
}

const scanReading = () => {
  const cv = window.cv
  
  if (video.value.readyState < 2) {
    status.value = "Waiting for camera...";
    return;
  }

  const src = cv.imread(video.value)
  const dst = new cv.Mat()
  
  // 1. Process Image
  cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY)
  // 2. Adjust Threshold (Try 100-127). Too high (e.g., 200) often results in a black screen.
  cv.threshold(dst, dst, 127, 255, cv.THRESH_BINARY); 
  
  // 2. Define ROI (50% center window)
  const w = dst.cols * 0.5, h = dst.rows * 0.5
  const roi = dst.roi(new cv.Rect(dst.cols * 0.25, dst.rows * 0.25, w, h))

  // 3. Digit Slot Helper
  const dW = w * 0.20, dH = h * 0.25
  const getDigit = (col, row) => {
    const dX = Math.round((w * 0.15) + (col * dW))
    const dY = Math.round((h * 0.10) + (row * h * 0.30))
    
    const pts = [
      {x: dW/2, y: 0}, {x: dW*0.9, y: dH*0.25}, {x: dW*0.9, y: dH*0.75},
      {x: dW/2, y: dH}, {x: dW*0.1, y: dH*0.75}, {x: dW*0.1, y: dH*0.25},
      {x: dW/2, y: dH/2}
    ]

    const bits = pts.map(pt => {
      const val = roi.ucharAt(dY + pt.y, dX + pt.x)
      // Draw debug dots on the ROI
      cv.circle(roi, new cv.Point(dX + pt.x, dY + pt.y), 2, new cv.Scalar(255), -1)
      return val < 128 ? "1" : "0"
    }).join("")

    return segmentMap[bits] ?? ""
  }

  // 4. Map Rows (37/38/25 split logic is implicit in row index)
  readings.value.sys = `${getDigit(0, 0)}${getDigit(1, 0)}${getDigit(2, 0)}`
  readings.value.dia = `${getDigit(0, 1)}${getDigit(1, 1)}${getDigit(2, 1)}`
  readings.value.pulse = `${getDigit(0, 2)}${getDigit(1, 2)}${getDigit(2, 2)}`

  cv.imshow(debugCanvas.value, roi)
  status.value = "Scan complete!"
  if (navigator.vibrate) navigator.vibrate(100)

  // Cleanup
  src.delete(); dst.delete(); roi.delete()
}

const saveToCloud = async () => {
  status.value = "Uploading..."
  const { sys, dia, pulse } = readings.value
  //const url = `https://thingspeak.com{THINGSPEAK_API_KEY}&field1=${sys}&field2=${dia}&field3=${pulse}`
  try {
    //await fetch(url)
    status.value = "Saved to ThingSpeak!"
  } catch {
    status.value = "Upload failed."
  }
}
</script>

<template>
  <div class="app">
    <h2>Omron OpenCV Scanner 2</h2>
    
    <div class="video-container">
      <video ref="video" autoplay playsinline></video>
      <div class="scan-overlay"></div>
    </div>

    <div class="ui">
      <p class="status">{{ status }}</p>
      
      <button @click="scanReading" :disabled="!cvReady" class="btn-main">
        {{ cvReady ? 'SCAN MONITOR' : 'LOADING...' }}
      </button>

      <div v-if="readings.sys" class="results">
        <div class="reading-row">SYS: {{ readings.sys }} | DIA: {{ readings.dia }} | PUL: {{ readings.pulse }}</div>
        <button @click="saveToCloud" class="btn-cloud">SEND TO THINGSPEAK</button>
      </div>

      <div class="debug-area">
        <p>Debug Dots View:</p>
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
.ui { margin-top: 15px; }
.btn-main { width: 100%; padding: 15px; background: #3b82f6; color: white; border: none; border-radius: 10px; font-weight: bold; }
.btn-cloud { width: 100%; padding: 12px; background: #10b981; color: white; border: none; border-radius: 8px; margin-top: 10px; }
.results { margin-top: 15px; padding: 15px; background: #f3f4f6; border-radius: 10px; }
canvas { width: 100%; margin-top: 10px; border: 1px solid #ccc; background: #000; }
.status { color: #3b82f6; font-weight: bold; min-height: 24px; }
</style>
