<script setup>
import { ref, onMounted } from 'vue'
import Tesseract from 'tesseract.js'

// --- CONFIGURATION ---
const THINGSPEAK_API_KEY = 'YOUR_WRITE_API_KEY' // <--- REPLACE THIS

const video = ref(null)
const previewCanvas = ref(null)
const status = ref('Align Omron screen in green box')
const readings = ref({ sys: null, dia: null, pulse: null })
const isScanning = ref(false)

// 1. Start Camera
onMounted(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: 'environment', focusMode: 'continuous' } 
    })
    video.value.srcObject = stream
  } catch (err) {
    status.value = "Camera error: " + err.message
  }
})

const scanReading = async () => {
  isScanning.value = true;
  status.value = "Reading screen...";
  
  const v = video.value;
  const canvas = previewCanvas.value;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // 1. Keep your Narrow Window (50% Wide, 50% High)
  const w = v.videoWidth;
  const h = v.videoHeight;
  const scanW = w * 0.50; 
  const scanX = w * 0.25; 
  const scanH = h * 0.50;
  const scanY = h * 0.25;

  // 2. Prepare the High-Res Canvas
  const scale = 2;
  canvas.width = scanW * scale;
  canvas.height = scanH * scale;
  
  ctx.filter = 'grayscale(100%) contrast(450%) brightness(85%) blur(0.5px)';
  ctx.drawImage(v, scanX, scanY, scanW, scanH, 0, 0, canvas.width, canvas.height);

  try {
    // 3. Single OCR Pass on the whole window
    const { data: { text } } = await Tesseract.recognize(canvas, 'eng', {
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '6' // Assume a single uniform block of text
    });

    // 4. Extract all numbers found in the text
    const foundNumbers = text.match(/\d+/g);

    if (foundNumbers && foundNumbers.length >= 2) {
      readings.value = {
        sys: foundNumbers[0],
        dia: foundNumbers[1],
        pulse: foundNumbers[2] || '?'
      };
      status.value = "Scan successful!";
      if (navigator.vibrate) navigator.vibrate(100);
    } else {
      status.value = "Found " + (foundNumbers?.length || 0) + " numbers. Try again.";
    }
  } catch (err) {
    status.value = "OCR Error.";
  } finally {
    isScanning.value = false;
  }
};

const scanReadingold = async () => {
  isScanning.value = true;
  status.value = "Scanning (35/35/30)...";
  
  const v = video.value;
  const canvas = previewCanvas.value;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // 1. Shrink the Window (Top 25%, Height 50%, Sides 15%)
  const w = v.videoWidth;
  const h = v.videoHeight;
  const scanX = w * 0.25;
  const scanY = h * 0.25; // Lowered from 20% to 25%
  const scanW = w * 0.50;
  const scanH = h * 0.50; // Shrunk from 60% to 50% for tighter focus

  // 2. Proportions: 35/35/30
  const sysH = scanH * 0.37;
  const diaH = scanH * 0.38;
  const pulseH = scanH * 0.25;

  // 3. Prepare Preview (High Contrast)
  canvas.width = scanW;
  canvas.height = scanH;
  ctx.filter = 'grayscale(100%) contrast(500%) brightness(80%) blur(0.5px)';
  ctx.drawImage(v, scanX, scanY, scanW, scanH, 0, 0, scanW, scanH);

  const getZoneText = async (yStart, height) => {
    const tempCanvas = document.createElement('canvas');
     // Scale up the zone by 2x to help Tesseract see shapes better
    const scale = 2; 
    tempCanvas.width = scanW * scale;
    tempCanvas.height = height * scale;
  
    const tempCtx = tempCanvas.getContext('2d');
  
    // Smooth the scaling for better OCR shapes
    tempCtx.imageSmoothingEnabled = true;
    tempCtx.imageSmoothingQuality = 'high';

    tempCtx.drawImage(
      canvas, 
      0, yStart, scanW, height,          // Source from preview
      0, 0, tempCanvas.width, tempCanvas.height // Scaled destination
    );

    const { data: { text } } = await Tesseract.recognize(tempCanvas, 'eng', {
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7', // Treat as a single line
    });
  
    return text.replace(/\D/g, '');
  };

  try {
    const sysResult = await getZoneText(0, sysH);
    const diaResult = await getZoneText(sysH, diaH);
    const pulseResult = await getZoneText(sysH + diaH, pulseH);

    // Validation & Mapping
    if (sysResult && diaResult) {
      readings.value = { 
        sys: sysResult, 
        dia: diaResult, 
        pulse: pulseResult || '?' 
      };
      status.value = "Scan successful!";
      if (navigator.vibrate) navigator.vibrate(100);
    } else {
      status.value = "Partial scan. Check alignment/glare.";
    }
  } catch (err) {
    status.value = "OCR Error.";
  } finally {
    isScanning.value = false;
  }
};


// 3. Send to ThingSpeak
const saveToCloud = async () => {
  if (!readings.value.sys) return
  status.value = "Uploading..."
  const url = `https://thingspeak.com{THINGSPEAK_API_KEY}&field1=${readings.value.sys}&field2=${readings.value.dia}&field3=${readings.value.pulse}`
  /*
  try {
    const res = await fetch(url)
    if (res.ok) status.value = "Saved to ThingSpeak!"
  } catch (err) {
    status.value = "Upload failed."
  }
  */
 status.value = `sys:${readings.value.sys} dia:${readings.value.dia} pul:${readings.value.pulse}`

}
</script>

<template>
  <div class="app-container">
    <h2>Omron M3 PWA</h2>
    
    <div class="video-wrap">
      <video ref="video" autoplay playsinline></video>
      <!-- Visual targeting guide -->
      <div class="scan-window">
        <!-- div class="scan-divider">SYS</div -->
        <!-- div class="scan-divider">DIA</div -->
        <!-- div class="scan-divider">PULSE</div -->
      </div>
    </div>
    
    <div class="controls">
      <p class="status-text">{{ status }}</p>
      <button @click="scanReading" :disabled="isScanning" class="btn-scan">
        {{ isScanning ? 'SCANNING...' : 'SCAN MONITOR' }}
      </button>
      
      <div v-if="readings.sys" class="results">
        <p><strong>SYS:</strong> {{ readings.sys }} | <strong>DIA:</strong> {{ readings.dia }}</p>
        <button @click="saveToCloud" class="btn-save">UPLOAD TO CLOUD</button>
      </div>

      <div class="debug">
        <p>AI View (Debug):</p>
        <canvas ref="previewCanvas" class="preview-canvas"></canvas>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-container { font-family: sans-serif; text-align: center; color: #333; max-width: 450px; margin: auto; padding: 10px; }
.video-wrap { position: relative; width: 100%; border-radius: 15px; overflow: hidden; background: #000; }
video { width: 100%; display: block; }

.scan-window {
  position: absolute;
  top: 25%;
  bottom: 25%;
  left: 25%;
  right: 25%;
  border: 3px solid #00ff00;
  box-shadow: 0 0 0 1000px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Optional: Add a simple hint text in the middle */
.scan-window::after {
  content: "ALIGN NUMBERS HERE";
  color: #00ff00;
  font-size: 10px;
  font-weight: bold;
  opacity: 0.5;
}



/* Target Box */
.oscan-window {
  position: absolute;
  top: 25%;    /* Matches JS startY */
  bottom: 25%; /* Matches JS scanH */
  left: 25%;
  right: 25%;
  border: 3px solid #00ff00;
  box-shadow: 0 0 0 1000px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  pointer-events: none;
}
.oscan-divider { 
  flex: 1; border-bottom: 1px dashed rgba(0,255,0,0.4); 
  color: #00ff00; font-size: 10px; padding: 5px; text-align: right; 
}
.oscan-divider:nth-child(1) { flex: 0.37; } /* SYS Gets 40% */
.oscan-divider:nth-child(2) { flex: 0.38; } /* DIA Gets 40% */
.oscan-divider:nth-child(3) { 
  flex: 0.25; 
  border-bottom: none; 
  font-size: 8px; /* Smaller label for the smaller pulse area */
}

/* UI Elements */
.status-text { font-weight: bold; margin: 15px 0; color: #3b82f6; height: 20px; }
button { width: 80%; padding: 15px; border-radius: 10px; border: none; font-weight: bold; margin: 10px 0; cursor: pointer; }
.btn-scan { background: #3b82f6; color: white; }
.btn-save { background: #10b981; color: white; }
.results { background: #f0fdf4; padding: 15px; border-radius: 10px; border: 1px solid #bbf7d0; }
.preview-canvas { width: 200px; border: 1px solid #ccc; margin-top: 5px; background: #000; }
.debug { margin-top: 20px; font-size: 12px; color: #666; }
</style>
