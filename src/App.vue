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

  const parseDigitBox = async (rect) => {
    const { x, y, width: dW, height: dH } = rect;

    // 1. Create a tiny canvas for just this one digit
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = dW * 3;  // Scale up for better OCR
    tempCanvas.height = dH * 3;
    const tempCtx = tempCanvas.getContext('2d');

    // 2. Draw the digit from the ROI into the tiny canvas
    // We use the ROI which is already high-contrast
    tempCtx.drawImage(
      debugCanvas.value, 
      x, y, dW, dH,           // Source coordinates in ROI
      0, 0, tempCanvas.width, tempCanvas.height  // Destination (scaled up)
    );

    // 3. Run Tesseract on this single box
    const { data: { text } } = await Tesseract.recognize(tempCanvas, 'eng', {
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '10', // '10' treats the image as a single character
    });

    // Clean the result (Tesseract sometimes adds newlines)
    const result = text.trim();
  
    // Show a little feedback in debug view
    cv.putText(roi, result, new cv.Point(x, y - 5), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(255), 1);
    return result;
};
/*
  const parseDigitBox = (rect) => {
    const segMap = {
      "1111110": "0", "0110000": "1", "1101101": "2", "1111001": "3", "0110011": "4",
      "1011011": "5", "1011111": "6", "1110000": "7", "1111111": "8", "1111011": "9"
    };
    const { x, y, width: dW, height: dH } = rect;
    //if box is narrow it can only be digit 1 no need to parse that numner
    if (dW < dH * 0.35) {
    return "1";
    }

    // Define 7 points relative to THIS specific box
    const pts = [
      {x: dW * 0.5,  y: dH * 0.15}, // a: top (down slightly)
      {x: dW * 0.85, y: dH * 0.3},  // b: TR (in slightly)
      {x: dW * 0.85, y: dH * 0.7},  // c: BR (in slightly)
      {x: dW * 0.5,  y: dH * 0.85}, // d: bottom (up slightly)
      {x: dW * 0.15, y: dH * 0.7},  // e: BL (in slightly)
      {x: dW * 0.15, y: dH * 0.3},  // f: TL (in slightly)
      {x: dW * 0.5,  y: dH * 0.5}   // g: middle (dead center)
    ];

    const bits = pts.map(pt => {
      const pxX = Math.round(x + pt.x);
      const pxY = Math.round(y + pt.y);
    
      if (pxY >= roi.rows || pxX >= roi.cols || pxY < 0 || pxX < 0) return "0";

      // --- AREA SAMPLING (5x5 grid) ---
      let blackPixels = 0;
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          if (roi.ucharAt(pxY + ky, pxX + kx) < 140) blackPixels++;
        }
      }

      // Draw the sensor dot for visual confirmation
      cv.circle(roi, new cv.Point(pxX, pxY), 1, new cv.Scalar(255), -1);

      // If more than 25% of the 25 pixels are black, segment is ON
      return blackPixels > 10 ? "1" : "0";
    }).join("");

    // --- THE RETURN LOGIC ---
    // 1. Check the standard map
    const detected = segMap[bits];
    if (detected) return detected;

    // 2. Fallback for "1": If the box is very narrow, it's a 1 even if sensors are slightly off
    if (rect.width < rect.height * 0.35) return "1";

    // 3. Fallback for common "noisy" 1 bitmasks
    if (bits === "0110000" || bits === "0100000" || bits === "0010000") return "1";

    return "";
  };
*/
  // Add this right before the digitBoxes.map(parseDigitBox) line
  let kernel = cv.Mat.ones(2, 2, cv.CV_8U);
  cv.erode(roi, roi, kernel); 
  kernel.delete();

  const parseAll = async (group) => {
    const results = await Promise.all(group.map(box => parseDigitBox(box)));
    return results.join("");
  };

  cv.imshow(debugCanvas.value, roi);
  try {
    const sys = await parseAll(sysGroup);
    const dia = await parseAll(diaGroup);
    const pulse = await parseAll(pulGroup);
    // Only update if we actually found something
    readings.value = { sys, dia, pulse };
    if (sys || dia) {
      readings.value = { sys, dia, pulse };
      status.value = "Scan successful!";
    }
  } catch (err) {
    console.error("OCR Error:", err);
  } finally {
    isProcessing.value = false; // Unlock for the next frame
    
    // Cleanup OpenCV memory (Crucial!)
    src.delete(); gray.delete(); roi.delete(); 
    if(inverted) inverted.delete();
    if(contours) contours.delete();
    if(hierarchy) hierarchy.delete();
  }
    
  //readings.value.sys = sysGroup.map(parseDigitBox).join("");
  //readings.value.dia = diaGroup.map(parseDigitBox).join("");
  //readings.value.pulse = pulGroup.map(parseDigitBox).join("");

  
  // 6. CLEANUP
  //src.delete(); gray.delete(); binary.delete(); roi.delete(); 
  //inverted.delete(); contours.delete(); hierarchy.delete(); M.delete();
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
