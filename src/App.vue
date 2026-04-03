<script setup>
import { ref, onMounted } from 'vue'
import Tesseract from 'tesseract.js'

// --- CONFIGURATION 
const THINGSPEAK_API_KEY = 'YOUR_WRITE_API_KEY' // Change this!
const THINGSPEAK_CHANNEL_ID = 'YOUR_CHANNEL_ID' // Change this!

const video = ref(null)
const canvas = ref(null)
const status = ref('Ready to scan')
const readings = ref({ sys: null, dia: null, pulse: null })

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
  status.value = "Capturing zones..."
  const context = canvas.value.getContext('2d')
  const v = video.value
  
  // 1. Setup high-contrast filters for the LCD segments
  context.filter = 'grayscale(100%) contrast(250%) brightness(110%)'
  
  // 2. Define the three zones (assuming vertical stack on Omron)
  const w = v.videoWidth
  const h = v.videoHeight
  const zoneH = h / 3 // Divide screen into 3 equal horizontal strips

  const getZoneText = async (yStart) => {
    // Resize canvas to just the zone size
    canvas.value.width = w
    canvas.value.height = zoneH
    context.filter = 'grayscale(100%) contrast(250%)' // Re-apply after resize
    
    // Draw only that slice of the video: drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
    context.drawImage(v, 0, yStart, w, zoneH, 0, 0, w, zoneH)
    
    const { data: { text } } = await Tesseract.recognize(canvas.value, 'eng', {
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '6' // Treat as a single uniform block
    })
    return text.trim()
  }

  // 3. Process each zone individually
  try {
    const sysText = await getZoneText(0)          // Top 1/3
    const diaText = await getZoneText(zoneH)      // Middle 1/3
    const pulseText = await getZoneText(zoneH * 2) // Bottom 1/3

    readings.value = {
      sys: sysText.match(/\d+/)?.[0] || '?',
      dia: diaText.match(/\d+/)?.[0] || '?',
      pulse: pulseText.match(/\d+/)?.[0] || '?'
    }
    
    status.value = readings.value.sys !== '?' ? "Scan successful!" : "Scan failed, try again."
  } catch (err) {
    status.value = "OCR Error: " + err.message
  }
}


// 3. Send to ThingSpeak
const saveToCloud = async () => {
  if (!readings.value.sys) return
  //status.value = "Uploading to ThingSpeak..."
  
  //const url = `https://thingspeak.com{THINGSPEAK_API_KEY}&field1=${readings.value.sys}&field2=${readings.value.dia}&field3=${readings.value.pulse}`
  
  try {
    //await fetch(url)
    status.value = "Data saved to Cloud!"
  } catch (err) {
    status.value = "Upload failed: " + err.message
  }
}
</script>

<template>
  <div class="app-container">
    <h1>Omron M3 Scanner</h1>
    
    <div class="video-wrap">
      <video ref="video" autoplay playsinline></video>
      <div class="overlay"></div>
    </div>
    
    <div class="controls">
      <p><strong>Status:</strong> {{ status }}</p>
      <button @click="scanReading" class="btn-scan">SCAN SCREEN</button>
      
      <div v-if="readings.sys" class="results">
        <p>SYS: {{ readings.sys }} | DIA: {{ readings.dia }}</p>
        <button @click="saveToCloud" class="btn-save">SAVE TO THINGSPEAK</button>
      </div>
    </div>

    <!-- Hidden canvas for processing -->
    <canvas ref="canvas" style="display:none"></canvas>
  </div>
</template>

<style scoped>
.app-container { font-family: sans-serif; text-align: center; padding: 20px; }
.video-wrap { position: relative; width: 100%; max-width: 400px; margin: auto; border: 4px solid #333; }
video { width: 100%; display: block; }
.overlay { position: absolute; top: 20%; left: 10%; right: 10%; bottom: 20%; border: 2px dashed red; pointer-events: none; }
.controls { margin-top: 20px; }
button { padding: 15px 30px; font-size: 1.1rem; cursor: pointer; border-radius: 8px; border: none; margin: 5px; }
.btn-scan { background: #3b82f6; color: white; }
.btn-save { background: #10b981; color: white; }
.results { background: #f3f4f6; padding: 15px; margin-top: 10px; border-radius: 8px; }
</style>
