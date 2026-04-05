

const prefilter = (cv, src, gray, binary) => {
    // Grayscale
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    
    // Normalize to handle glare on the Omron screen
    cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
    cv.medianBlur(gray, gray, 3);
    
    // Adaptive Threshold (Strict for LCD segments)
    // 15 is the block size, 15 is the constant subtracted from the mean
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 15);
  };

  const findDigitBoxes = (cv, roi, scanSize) => {
    // Prepare WorkMats
    let workMat = new cv.Mat();
    //let M = cv.Mat.ones(3, 3, cv.CV_8U);
    let M = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 5));
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
  
    // Setup WorkMat (Invert + Border + Dilate)
    cv.bitwise_not(roi, workMat);
    cv.rectangle(workMat, new cv.Point(0,0), new cv.Point(workMat.cols, workMat.rows), new cv.Scalar(0), 5);
    cv.dilate(workMat, workMat, M);
    
    // Find Initial Blobs
    cv.findContours(workMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    
    // keep the contours that seem to have the correct dimesions for a digit
    let rawBoxes = []; 
    for (let i = 0; i < contours.size(); ++i) {
      const rect = cv.boundingRect(contours.get(i));
      const relH = rect.height / scanSize;
      const relW = rect.width / roi.cols;
      const relX = rect.x / roi.cols; 
      const relY = rect.y / scanSize;
      const aspect = rect.height / rect.width;
      // position 
      if (relX < 0.20) continue;
      if (relY < 0.08) continue;
      // oversized rects
      if (relH > 0.40 || relW > 0.40) continue;
      // speckles 
      if (rect.height < 8 || rect.width < 3) continue;
      // aspect
      if (aspect < 1.2) continue;
      rawBoxes.push(rect);
    }
    // may be a need to add vertical merging but it seems to work without it
    workMat.delete(); M.delete(); contours.delete(); hierarchy.delete();
    return rawBoxes;
  };

  const parseDigitBox = (cv, roiMat, rect) => {
    const { x, y, width: dW, height: dH } = rect; 
    let digitMat = roiMat.roi(rect);
  
    // Quick fix for the "1" (high aspect ratio)
    if (dH / dW > 3) {
      digitMat.delete();
      return "1";
    }
  
    const segments = [
        // [x, y, w, h]
      [0.3, 0.05, 0.4, 0.15],  // A (Top)
      [0.8, 0.1, 0.15, 0.35],  // B (Upper Right)
      [0.8, 0.55, 0.15, 0.35], // C (Lower Right)
      [0.3, 0.8, 0.4, 0.15],   // D (Bottom)
      
      // TIGHTEN THESE TWO:
      [0.06, 0.62, 0.17, 0.23], // E (Lower Left) - Very thin, far left
      [0.06, 0.18, 0.17, 0.23],// F (Upper Left) - Very thin, far left
      
      [0.3, 0.40, 0.4, 0.2],   // G (Middle)
    ];
  
    const active = segments.map(([sX, sY, sW, sH]) => {
      const segRect = new cv.Rect(sX * dW, sY * dH, sW * dW, sH * dH);
      const segRoi = digitMat.roi(segRect);
      const onPixels = cv.countNonZero(segRoi);
      const totalPixels = segRect.width * segRect.height;
      segRoi.delete();
      cv.rectangle(roiMat, 
        new cv.Point(rect.x + (sX * dW), rect.y + (sY * dH)), 
        new cv.Point(rect.x + (sX + sW) * dW, rect.y + (sY + sH) * dH), 
        new cv.Scalar(255), 1);
      return (onPixels / totalPixels > 0.40 ) ? 1 : 0;
    });
  
    const lookup = {
      "1111110": "0", "0110000": "1", "1101101": "2", "1111001": "3", "0110011": "4",
      "1011011": "5", "1011111": "6", "1110000": "7", "1111111": "8", "1111011": "9"
    };
    const result = lookup[active.join("")] || "-";
    digitMat.delete();
    return result;
  };

  const prepareScanner = (cv, canvas) => {
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const binary = new cv.Mat();
    
    prefilter(cv, src, gray, binary);
    
    // 2. Handle ROI Math
    const scanSize = binary.cols * 0.28;
    const rect = new cv.Rect((binary.cols - scanSize)/2, (binary.rows - scanSize)/2, scanSize, scanSize);
    const roi = binary.roi(rect);
  
    // 3. Find Boxes while still in "Black on White"
    const digitBoxes = findDigitBoxes(cv, roi, scanSize);
  
    // 4. Flip ROI for the UI and segment math
    cv.bitwise_not(roi, roi);
  
    digitBoxes.forEach(box => {
        cv.rectangle(roi, 
            new cv.Point(box.x, box.y), 
            new cv.Point(box.x + box.width, box.y + box.height), 
            new cv.Scalar(150), 2
        );
      });

    // Cleanup temporary mats 
    src.delete(); 
    gray.delete();
    binary.delete();
  
    return { src, roi, digitBoxes, scanSize };
  };


  const getReadings = (cv, roi, digitBoxes, scanSize) => {
    // Helper to handle the "Lambda Chain": Filter -> Sort -> Map -> Join
    const processRow = (minY, maxY) => {
      return digitBoxes
        .filter(box => box.y >= minY && box.y < maxY)
        .sort((a, b) => a.x - b.x) // Sort Left-to-Right
        .map(box => parseDigitBox(cv, roi, box))
        .join("");
    };
  
    return {
      sys:   processRow(0, scanSize * 0.38),
      dia:   processRow(scanSize * 0.38, scanSize * 0.72),
      pulse: processRow(scanSize * 0.72, scanSize)
    };
  };
  
  export { prepareScanner, getReadings, prefilter, findDigitBoxes, parseDigitBox };