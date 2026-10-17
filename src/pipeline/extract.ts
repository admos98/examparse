/**
 * Stage 1: Document Extraction Pipeline (§6.1)
 * Extracts text lines, line coordinates, and embedded images from PDF, DOCX, TXT, MD, and image scans.
 */
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { ImageAsset, SourceLine } from '../types';
import { computeImageDHash, hammingDistance, isNearUniformColor, sha256 } from '../utils/hash';
import { saveImageBlob } from '../store';

// Configure pdfjs worker in Vite
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
} catch (e) {
  console.warn('PDF.js worker setup fallback:', e);
}

export interface ExtractedDocument {
  lines: SourceLine[];
  pages: number;
  ocrUsed: boolean;
  fileName: string;
  images: ImageAsset[];
  scannedPageIndices: number[]; // 1-based page indices with <100 chars
  pageImages: string[]; // data URLs of rendered pages
}

function multiplyTransform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export async function extractDocument(file: File): Promise<ExtractedDocument> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (extension === 'pdf') {
    return await extractPdf(file);
  } else if (extension === 'docx') {
    return await extractDocx(file);
  } else if (['jpg', 'jpeg', 'png', 'webp'].includes(extension || '')) {
    return await extractSingleImageScan(file);
  } else {
    // txt, md, etc.
    return await extractPlainText(file);
  }
}

/**
 * PDF Extraction with layout-aware line sorting, direction, columns & embedded image extraction
 */
async function extractPdf(file: File): Promise<ExtractedDocument> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf = await loadingTask.promise;

  const lines: SourceLine[] = [];
  const images: (ImageAsset & { _dHash?: string })[] = [];
  const scannedPageIndices: number[] = [];
  const pageImages: string[] = [];

  let globalLineNumber = 1;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });

    // 1. Render page preview thumbnail to offscreen canvas
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      await (page.render({ canvasContext: ctx, viewport, canvas } as any)).promise;
      pageImages.push(canvas.toDataURL('image/jpeg', 0.8));
    }

    // 2. Extract text items with layout coordinates and direction
    const textContent = await page.getTextContent();
    let pageCharCount = 0;

    interface TextItemPos {
      str: string;
      x: number;
      y: number;
      w: number;
      h: number;
      dir: 'ltr' | 'rtl';
    }

    const items: TextItemPos[] = [];
    for (const item of textContent.items as any[]) {
      if (!item.str) continue;
      pageCharCount += item.str.length;
      const tx = item.transform; // [scaleX, skewY, skewX, scaleY, transX, transY]
      const fontHeight = Math.abs(tx[3]) || item.height || 12;
      items.push({
        str: item.str,
        x: tx[4],
        y: tx[5],
        w: item.width || 0,
        h: fontHeight,
        dir: item.dir === 'rtl' ? 'rtl' : 'ltr',
      });
    }

    // Check if page is scanned (< 100 characters)
    if (pageCharCount < 100) {
      scannedPageIndices.push(pageNum);
    }

    // Cluster items into lines by y-coordinate (tolerance ~4px)
    items.sort((a, b) => b.y - a.y); // top-to-bottom

    const lineClusters: TextItemPos[][] = [];
    for (const item of items) {
      const matchCluster = lineClusters.find(
        c => Math.abs(c[0].y - item.y) <= 4
      );
      if (matchCluster) {
        matchCluster.push(item);
      } else {
        lineClusters.push([item]);
      }
    }

    for (const cluster of lineClusters) {
      const rtlCount = cluster.filter(i => i.dir === 'rtl').length;
      const isRtl = rtlCount > cluster.length / 2;

      // Sort line items along reading axis: rtl -> descending x, ltr -> ascending x
      if (isRtl) {
        cluster.sort((a, b) => b.x - a.x);
      } else {
        cluster.sort((a, b) => a.x - b.x);
      }

      // Split a y-cluster into separate lines on large x-gaps (column break)
      const columnSegments: TextItemPos[][] = [];
      let currentSegment: TextItemPos[] = [];

      for (let i = 0; i < cluster.length; i++) {
        const item = cluster[i];
        if (currentSegment.length === 0) {
          currentSegment.push(item);
        } else {
          const prev = currentSegment[currentSegment.length - 1];
          const gap = isRtl
            ? (prev.x - (item.x + item.w))
            : (item.x - (prev.x + prev.w));
          const avgFontHeight = (prev.h + item.h) / 2 || 12;

          // Split into separate lines on large x-gaps (column break: gap > 45px or > 3.5x font height)
          if (gap > Math.max(45, avgFontHeight * 3.5)) {
            columnSegments.push(currentSegment);
            currentSegment = [item];
          } else {
            currentSegment.push(item);
          }
        }
      }
      if (currentSegment.length > 0) {
        columnSegments.push(currentSegment);
      }

      // For each segment: join fragments by x-gap (space only when gap > ~0.3x font height)
      for (const segment of columnSegments) {
        let lineText = '';
        for (let i = 0; i < segment.length; i++) {
          const item = segment[i];
          if (i === 0) {
            lineText += item.str;
          } else {
            const prev = segment[i - 1];
            const avgFontHeight = (prev.h + item.h) / 2 || 12;
            const gap = isRtl
              ? (prev.x - (item.x + item.w))
              : (item.x - (prev.x + prev.w));

            // Space only when gap > ~0.3x font height
            if (gap > avgFontHeight * 0.3) {
              lineText += ' ';
            }
            lineText += item.str;
          }
        }

        const trimmed = lineText.trim();
        if (!trimmed) continue;

        const lineId = `L${String(globalLineNumber).padStart(4, '0')}`;
        lines.push({
          id: lineId,
          page: pageNum,
          text: trimmed,
          y: segment[0].y,
        });
        globalLineNumber++;
      }
    }

    // 3. Extract Embedded Images from PDF with transform tracking and placement geometry
    try {
      const ops = await page.getOperatorList();
      let currentMatrix = [1, 0, 0, 1, 0, 0];
      const matrixStack: number[][] = [];
      const imagePlacements: { name: string; transform: number[] }[] = [];

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === pdfjsLib.OPS.save) {
          matrixStack.push([...currentMatrix]);
        } else if (fn === pdfjsLib.OPS.restore) {
          currentMatrix = matrixStack.pop() || [1, 0, 0, 1, 0, 0];
        } else if (fn === pdfjsLib.OPS.transform) {
          currentMatrix = multiplyTransform(currentMatrix, args);
        } else if (
          fn === pdfjsLib.OPS.paintImageXObject ||
          fn === pdfjsLib.OPS.paintInlineImageXObject
        ) {
          const imgArg = args[0];
          if (imgArg) {
            imagePlacements.push({ name: imgArg, transform: [...currentMatrix] });
          }
        }
      }

      for (let idx = 0; idx < imagePlacements.length; idx++) {
        const { name: objName, transform } = imagePlacements[idx];
        let imgObj: any = null;
        try {
          imgObj = await new Promise((resolve) => {
            page.objs.get(objName, (o: any) => resolve(o));
          });
        } catch {}

        if (!imgObj) continue;

        const hasBitmap = Boolean(imgObj.bitmap);
        const hasData = Boolean(imgObj.data);
        if (!hasBitmap && !hasData) continue;

        const imgWidth = imgObj.width || (imgObj.bitmap ? imgObj.bitmap.width : 100);
        const imgHeight = imgObj.height || (imgObj.bitmap ? imgObj.bitmap.height : 100);

        if (imgWidth < 32 || imgHeight < 32) continue;

        // Placement from transform matrix
        const pdfX = transform[4];
        const pdfY = transform[5];
        const pdfW = Math.hypot(transform[0], transform[1]);
        const pdfH = Math.hypot(transform[2], transform[3]);

        const [vx, vy] = viewport.convertToViewportPoint(pdfX, pdfY + pdfH);
        const vw = pdfW * viewport.scale;
        const vh = pdfH * viewport.scale;
        const bbox = {
          x: Math.round(vx),
          y: Math.round(vy),
          w: Math.round(vw),
          h: Math.round(vh),
        };

        // Exclude images covering ≥ 90% of a scanned page from ImageAssets
        const isScannedPage = scannedPageIndices.includes(pageNum);
        const pageArea = viewport.width * viewport.height;
        const imgDisplayArea = bbox.w * bbox.h;
        if (isScannedPage && (imgDisplayArea >= 0.9 * pageArea || imgWidth * imgHeight >= 0.9 * pageArea)) {
          continue;
        }

        // Render imgObj to offscreen canvas (handling bitmap & byte buffers)
        const imgCanvas = document.createElement('canvas');
        imgCanvas.width = imgWidth;
        imgCanvas.height = imgHeight;
        const imgCtx = imgCanvas.getContext('2d');
        if (!imgCtx) continue;

        if (hasBitmap) {
          imgCtx.drawImage(imgObj.bitmap, 0, 0);
        } else if (hasData) {
          const imgData = imgCtx.createImageData(imgWidth, imgHeight);
          const srcData = imgObj.data;
          if (srcData.length === imgWidth * imgHeight * 4) {
            imgData.data.set(srcData);
          } else if (srcData.length === imgWidth * imgHeight * 3) {
            let d = 0;
            for (let s = 0; s < srcData.length; s += 3) {
              imgData.data[d] = srcData[s];
              imgData.data[d + 1] = srcData[s + 1];
              imgData.data[d + 2] = srcData[s + 2];
              imgData.data[d + 3] = 255;
              d += 4;
            }
          } else {
            let d = 0;
            for (let s = 0; s < srcData.length; s++) {
              const val = srcData[s];
              imgData.data[d] = val;
              imgData.data[d + 1] = val;
              imgData.data[d + 2] = val;
              imgData.data[d + 3] = 255;
              d += 4;
            }
          }
          imgCtx.putImageData(imgData, 0, 0);
        }

        if (isNearUniformColor(imgCanvas)) continue;

        // Convert to Blob and compute SHA-256 & dHash
        const blob = await new Promise<Blob | null>(res => imgCanvas.toBlob(res, 'image/jpeg', 0.85));
        if (!blob) continue;

        const buffer = await blob.arrayBuffer();
        const imgSha = await sha256(buffer);
        const dHash = await computeImageDHash(imgCanvas);

        // Deduplication check: compare SHA or dHash (Hamming distance <= 6)
        let duplicateId: string | undefined = undefined;
        for (const ex of images) {
          if (ex.sha === imgSha) {
            duplicateId = ex.duplicateOf || ex.id;
            break;
          }
          if (ex._dHash && dHash) {
            const dist = hammingDistance(dHash, ex._dHash);
            if (dist <= 6) {
              duplicateId = ex.duplicateOf || ex.id;
              break;
            }
          }
        }

        const assetId = `img_${String(images.length + 1).padStart(3, '0')}`;
        await saveImageBlob(imgSha, blob);

        // Find nearest source line by y-coordinate on this page
        const pageLines = lines.filter(l => l.page === pageNum);
        let nearestLine: SourceLine | undefined = undefined;
        let minLineDist = Infinity;
        for (const pl of pageLines) {
          if (pl.y !== undefined) {
            const dist = Math.abs(pl.y - pdfY);
            if (dist < minLineDist) {
              minLineDist = dist;
              nearestLine = pl;
            }
          }
        }
        const anchorNum = nearestLine
          ? parseInt(nearestLine.id.replace('L', ''), 10)
          : undefined;

        images.push({
          id: assetId,
          page: pageNum,
          bbox,
          mime: 'image/jpeg',
          sha: imgSha,
          width: imgWidth,
          height: imgHeight,
          anchorLine: anchorNum,
          duplicateOf: duplicateId,
          blobKey: imgSha,
          dataUrl: URL.createObjectURL(blob),
          _dHash: dHash,
        });
      }
    } catch (err) {
      console.warn('PDF image extraction note:', err);
    }
  }

  return {
    lines,
    pages: pdf.numPages,
    ocrUsed: scannedPageIndices.length > 0,
    fileName: file.name,
    images,
    scannedPageIndices,
    pageImages,
  };
}

/**
 * DOCX Extraction using mammoth + JSZip with real dimensions & document order anchors
 */
async function extractDocx(file: File): Promise<ExtractedDocument> {
  const arrayBuffer = await file.arrayBuffer();

  // Extract HTML text
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const html = result.value;

  // Convert HTML elements into sequential lines and track img positions in document order
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const rawParagraphs: string[] = [];
  const imgAnchorLines: number[] = [];

  let currentLineIndex = 1;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.tagName === 'IMG') {
        imgAnchorLines.push(currentLineIndex);
      }
      if (['P', 'H1', 'H2', 'H3', 'LI', 'TR'].includes(el.tagName)) {
        const text = el.innerText?.trim();
        if (text) {
          rawParagraphs.push(text);
          const subCount = text.split('\n').map(s => s.trim()).filter(Boolean).length;
          currentLineIndex += subCount;
          return;
        }
      }
      for (let c = 0; c < el.childNodes.length; c++) {
        walk(el.childNodes[c]);
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        rawParagraphs.push(text);
        currentLineIndex++;
      }
    }
  };
  walk(tempDiv);

  const lines: SourceLine[] = [];
  let lineNum = 1;
  for (const p of rawParagraphs) {
    const subLines = p.split('\n').map(s => s.trim()).filter(Boolean);
    for (const sub of subLines) {
      lines.push({
        id: `L${String(lineNum).padStart(4, '0')}`,
        page: 1,
        text: sub,
      });
      lineNum++;
    }
  }

  // Read images from /word/media/* via JSZip
  const zip = await JSZip.loadAsync(arrayBuffer);
  const images: ImageAsset[] = [];

  const mediaFiles: { name: string; file: JSZip.JSZipObject }[] = [];
  zip.forEach((relPath, entry) => {
    if (relPath.startsWith('word/media/') && !entry.dir) {
      mediaFiles.push({ name: relPath, file: entry });
    }
  });

  for (let i = 0; i < mediaFiles.length; i++) {
    const media = mediaFiles[i];
    const blobData = await media.file.async('blob');
    const buffer = await blobData.arrayBuffer();
    const imgSha = await sha256(buffer);
    const mime = media.name.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const assetId = `img_${String(i + 1).padStart(3, '0')}`;

    // Decode real image width and height
    const dataUrl = URL.createObjectURL(blobData);
    const dimensions = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
      img.onerror = () => resolve({ w: 400, h: 300 });
      img.src = dataUrl;
    });

    await saveImageBlob(imgSha, blobData);

    const anchorLine = imgAnchorLines[i] || 1;

    images.push({
      id: assetId,
      page: 1,
      bbox: { x: 0, y: 0, w: dimensions.w, h: dimensions.h },
      mime,
      sha: imgSha,
      width: dimensions.w,
      height: dimensions.h,
      anchorLine,
      blobKey: imgSha,
      dataUrl,
    });
  }

  return {
    lines,
    pages: 1,
    ocrUsed: false,
    fileName: file.name,
    images,
    scannedPageIndices: [],
    pageImages: [],
  };
}

/**
 * Plain Text or Markdown file extraction
 */
async function extractPlainText(file: File): Promise<ExtractedDocument> {
  const text = await file.text();
  const rawLines = text.split(/\r?\n/);
  const lines: SourceLine[] = [];

  let lineNum = 1;
  let page = 1;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('=== PAGE') && trimmed.endsWith('===')) {
      const match = trimmed.match(/=== PAGE\s*(\d+)\s*===/i);
      if (match) page = parseInt(match[1], 10);
      continue;
    }

    lines.push({
      id: `L${String(lineNum).padStart(4, '0')}`,
      page,
      text: raw,
    });
    lineNum++;
  }

  return {
    lines,
    pages: page,
    ocrUsed: false,
    fileName: file.name,
    images: [],
    scannedPageIndices: [],
    pageImages: [],
  };
}

/**
 * Single Image Scan (treating image as a 1-page exam scan)
 */
async function extractSingleImageScan(file: File): Promise<ExtractedDocument> {
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });

  return {
    lines: [],
    pages: 1,
    ocrUsed: true,
    fileName: file.name,
    images: [],
    scannedPageIndices: [1],
    pageImages: [dataUrl],
  };
}
