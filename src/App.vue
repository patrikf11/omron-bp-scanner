<script setup>
import { ref, onMounted } from 'vue'

const THINGSPEAK_API_KEY = 'YOUR_WRITE_API_KEY'
const segmentMap = {
  "1111110": "0", "0110000": "1", "1101101": "2", "1111001": "3", "0110011": "4",
  "1011011": "5", "1011111": "6", "1110000": "7", "1111111": "8", "1111011": "9"
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
      clearInterval(checkCV); cvReady.value = true;
      status.value = 'Ready. Align Omron in Square.'; startCamera();
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
  if (!video.value || video.value.readyState < 2 || video.value.paused) return;

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = video.value.videoWidth;
  tempCanvas.height = video.value.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(video.value, 0, 0);

  const src = cv.imread(tempCanvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  
  // 1. Convert & Stretch Contrast (Makes grey background go white, digits go black)
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
  
  // 2. Strict Threshold: Adjust '100' if digits don't appear. 
  // Lower (e.g. 80) if screen is too white. Higher (e.g. 130) if screen is too black.
  cv.threshold(gray, binary, 100, 255, cv.THRESH_BINARY_INV); 

  // 3. Define ROI (Matches your 28vw square)
  const vW = binary.cols, vH = binary.rows;
  const scanSize = vW * 0.28;
  const roi = binary.roi(new cv.Rect((vW - scanSize)/2, (vH - scanSize)/2, scanSize, scanSize));

  // 4. Find Contours (Looking for the white digits on black)
  let contours = new cv.MatVector(), hierarchy = new cv.Mat();
  cv.findContours(roi, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let digitBoxes = [];
  for (let i = 0; i < contours.size(); ++i) {
    let rect = cv.boundingRect(contours.get(i));
    // Filter: Omron digits are taller than they are wide.
    if (rect.height > 15 && rect.height > rect.width) {
      digitBoxes.push(rect);
    }
  }

  // 5. Vertical Merger (To handle the "1" being split)
  let merged = [];
  digitBoxes.sort((a, b) => a.x - b.x);
  for (let i = 0; i < digitBoxes.length; i++) {
    let curr = digitBoxes[i], isAdded = false;
    for (let j = 0; j < merged.length; j++) {
      let prev = merged[j];
      const hOverlap = Math.abs(curr.x - prev.x) < (scanSize * 0.05);
      const vGap = curr.y - (prev.y + prev.height);
      if (hOverlap && vGap < curr.height) {
        prev.height = Math.max(prev.y + prev.height, curr.y + curr.height) - prev.y;
        isAdded = true; break;
      }
    }
    if (!isAdded) merged.push(curr);
  }

  // 6. Final Segment Mapping
  const parseDigit = (rect) => {
    const { x, y, width: dW, height: dH } = rect;
    // Draw the green boxes for feedback
    cv.rectangle(roi, new cv.Point(x, y), new cv.Point(x + dW, y + dH), new cv.Scalar(255), 1);
    
    const pts = [
      {x: dW*0.5, y: dH*0.1}, {x: dW*0.85, y: dH*0.25}, {x: dW*0.85, y: dH*0.75},
      {x: dW*0.5, y: dH*0.9}, {x: dW*0.15, y: dH*0.75}, {x: dW*0.15, y: dH*0.25},
      {x: dW*0.5, y: dH*0.5}
    ];

    const bits = pts.map(pt => {
      const pxX = Math.round(x + pt.x), pxY = Math.round(y + pt.y);
      if (pxY >= roi.rows || pxX >= roi.cols) return "0";
      // Since background is black (0) and digits are white (255), check for > 128
      return roi.ucharAt(pxY, pxX) > 128 ? "1" : "0";
    }).join("");
    
    return segmentMap[bits] ?? "";
  };

  // Group by rows (37/38/25 split)
  let sysRow = [], diaRow = [], pulRow = [];
  merged.forEach(box => {
    const cy = box.y + box.height/2;
    if (cy < scanSize * 0.37) sysRow.push(box);
    else if (cy < scanSize * 0.75) diaRow.push(box);
    else pulRow.push(box);
  });

  const sortX = (a, b) => a.x - b.x;
  readings.value.sys = sysRow.sort(sortX).map(parseDigit).join("");
  readings.value.dia = diaRow.sort(sortX).map(parseDigit).join("");
  readings.value.pulse = pulRow.sort(sortX).map(parseDigit).join("");

  cv.imshow(debugCanvas.value, roi);
  src.delete(); gray.delete(); binary.delete(); roi.delete(); contours.delete(); hierarchy.delete();
};

const processFrameX = () => {
  const cv = window.cv
  if (!video.value || video.value.readyState < 2 || video.value.paused) return

  // 1. Capture to Temp Canvas
  const tempCanvas = document.createElement('canvas')
  tempCanvas.width = video.value.videoWidth
  tempCanvas.height = video.value.videoHeight
  const tempCtx = tempCanvas.getContext('2d')
  tempCtx.drawImage(video.value, 0, 0)

  // 2. Load into OpenCV
  const src = cv.imread(tempCanvas)
  const gray = new cv.Mat()
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX)
  
  // Use Adaptive Threshold for better grey/dark-grey distinction
  cv.adaptiveThreshold(gray, gray, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 12)

  // 3. Define Square ROI (28% of Width)
  const vW = gray.cols, vH = gray.rows
  const scanSize = vW * 0.28
  const roi = gray.roi(new cv.Rect((vW - scanSize)/2, (vH - scanSize)/2, scanSize, scanSize))

  // 4. Find Contours
  let inverted = new cv.Mat()
  cv.bitwise_not(roi, inverted) // Invert so digits are white for contours
  let contours = new cv.MatVector(), hierarchy = new cv.Mat()
  cv.findContours(inverted, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

  let digitBoxes = []
  for (let i = 0; i < contours.size(); ++i) {
    let rect = cv.boundingRect(contours.get(i))
    // Filter out noise: digits are vertical rectangles
    if (rect.height > 15 && rect.height > rect.width) {
      digitBoxes.push(rect)
    }
  }

  // 5. Vertical Merger (Fixes the "1" split issue)
  let merged = []
  digitBoxes.sort((a, b) => a.x - b.x)
  for (let i = 0; i < digitBoxes.length; i++) {
    let curr = digitBoxes[i], isAdded = false
    for (let j = 0; j < merged.length; j++) {
      let prev = merged[j]
      const hOverlap = Math.abs(curr.x - prev.x) < (scanSize * 0.05)
      const vGap = curr.y - (prev.y + prev.height)
      if (hOverlap && vGap < curr.height) {
        prev.height = Math.max(prev.y + prev.height, curr.y + curr.height) - prev.y
        isAdded = true; break
      }
    }
    if (!isAdded) merged.push(curr)
  }

  // 6. Segment Analysis Function
  const parseDigit = (rect) => {
    const { x, y, width: dW, height: dH } = rect
    cv.rectangle(roi, new cv.Point(x, y), new cv.Point(x + dW, y + dH), new cv.Scalar(150), 1)
    
    const pts = [
      {x: dW*0.5, y: dH*0.1}, {x: dW*0.85, y: dH*0.25}, {x: dW*0.85, y: dH*0.75},
      {x: dW*0.5, y: dH*0.9}, {x: dW*0.15, y: dH*0.75}, {x: dW*0.15, y: dH*0.25},
      {x: dW*0.5, y: dH*0.5}
    ]

    const bits = pts.map(pt => {
      const pxX = Math.round(x + pt.x), pxY = Math.round(y + pt.y)
      if (pxY >= roi.rows || pxX >= roi.cols) return "0"
      cv.circle(roi, new cv.Point(pxX, pxY), 1, new cv.Scalar(255), -1)
      return roi.ucharAt(pxY, pxX) < 128 ? "1" : "0" // Black pixel = ON
    }).join("")
    
    if (bits === "0110000" || bits === "0100000" || bits === "0010000") return "1"
    return segmentMap[bits] ?? ""
  }

  // 7. Sort into Rows (37/38/25 split)
  let sysRow = [], diaRow = [], pulRow = []
  merged.forEach(box => {
    const cy = box.y + box.height/2
    if (cy < scanSize * 0.37) sysRow.push(box)
    else if (cy < scanSize * 0.75) diaRow.push(box)
    else pulRow.push(box)
  })

  const sortX = (a, b) => a.x - b.x
  readings.value.sys = sysRow.sort(sortX).map(parseDigit).join("")
  readings.value.dia = diaRow.sort(sortX).map(parseDigit).join("")
  readings.value.pulse = pulRow.sort(sortX).map(parseDigit).join("")

  cv.imshow(debugCanvas.value, roi)
  src.delete(); gray.delete(); roi.delete(); inverted.delete(); contours.delete(); hierarchy.delete()
}

const saveToCloud = async () => {
  status.value = "Uploading..."
  const { sys, dia, pulse } = readings.value
  const url = `https://thingspeak.com{THINGSPEAK_API_KEY}&field1=${sys}&field2=${dia}&field3=${pulse}`
  try {
    await fetch(url); status.value = "Saved!"
    if (navigator.vibrate) navigator.vibrate(200)
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
        <p>Debug (Boxes & Dots):</p>
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
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 28vw; aspect-ratio: 1 / 1; border: 2px solid #00ff00; 
  box-shadow: 0 0 0 1000px rgba(0,0,0,0.5); pointer-events: none;
}
.ui { margin-top: 10px; }
button { width: 100%; padding: 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
.btn-start { background: #3b82f6; color: white; }
.btn-stop { background: #ef4444; color: white; }
.btn-cloud { background: #10b981; color: white; margin-top: 8px; }
.results { margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px; border: 1px solid #ddd; }
.row { font-size: 1.2rem; font-weight: bold; margin-bottom: 8px; }
canvas { width: 100%; margin-top: 8px; border: 1px solid #ccc; background: #000; border-radius: 6px; }
.status { color: #3b82f6; font-size: 0.9rem; min-height: 1.2rem; }
</style>
