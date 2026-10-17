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
 * PDF Extraction with layout-aware line sorting & embedded image extraction
 */
async function extractPdf(file: File): Promise<ExtractedDocument> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf = await loadingTask.promise;

  const lines: SourceLine[] = [];
  const images: ImageAsset[] = [];
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

    // 2. Extract text items with layout coordinates
    const textContent = await page.getTextContent();
    let pageCharCount = 0;

    // Group text items by vertical position (y coordinate)
    interface TextItemPos {
      str: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }

    const items: TextItemPos[] = [];
    for (const item of textContent.items as any[]) {
      if (!item.str) continue;
      pageCharCount += item.str.length;
      const tx = item.transform; // [scaleX, skewY, skewX, scaleY, transX, transY]
      items.push({
        str: item.str,
        x: tx[4],
        y: tx[5],
        w: item.width || 0,
        h: item.height || 0,
      });
    }

    // Check if page is scanned (< 100 characters)
    if (pageCharCount < 100) {
      scannedPageIndices.push(pageNum);
    }

    // Cluster items into lines by y-coordinate (tolerance ~4px)
    items.sort((a, b) => b.y - a.y || a.x - b.x); // top-to-bottom

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

    // Add PAGE marker
    // Note: Page markers "=== PAGE n ===" are not lines according to §8 T1
    // We store page in SourceLine metadata

    for (const cluster of lineClusters) {
      // Sort cluster items left-to-right (or right-to-left based on positions)
      cluster.sort((a, b) => a.x - b.x);
      const lineText = cluster.map(i => i.str).join(' ').trim();
      if (!lineText) continue;

      const lineId = `L${String(globalLineNumber).padStart(4, '0')}`;
      lines.push({
        id: lineId,
        page: pageNum,
        text: lineText,
        y: cluster[0].y,
      });
      globalLineNumber++;
    }

    // 3. Extract Embedded Images from PDF
    try {
      const ops = await page.getOperatorList();
      const imageNames: string[] = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (
          ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject ||
          ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject
        ) {
          const imgArg = ops.argsArray[i][0];
          if (imgArg) imageNames.push(imgArg);
        }
      }

      for (let idx = 0; idx < imageNames.length; idx++) {
        const objName = imageNames[idx];
        let imgObj: any = null;
        try {
          imgObj = await new Promise((resolve) => {
            page.objs.get(objName, (o: any) => resolve(o));
          });
        } catch {}

        if (!imgObj || !imgObj.data) continue;

        const imgWidth = imgObj.width || 100;
        const imgHeight = imgObj.height || 100;

        if (imgWidth < 32 || imgHeight < 32) continue;

        // Render imgObj to offscreen canvas
        const imgCanvas = document.createElement('canvas');
        imgCanvas.width = imgWidth;
        imgCanvas.height = imgHeight;
        const imgCtx = imgCanvas.getContext('2d');
        if (!imgCtx) continue;

        const imgData = imgCtx.createImageData(imgWidth, imgHeight);
        const srcData = imgObj.data;
        if (srcData.length === imgWidth * imgHeight * 4) {
          imgData.data.set(srcData);
        } else if (srcData.length === imgWidth * imgHeight * 3) {
          // RGB -> RGBA
          let d = 0;
          for (let s = 0; s < srcData.length; s += 3) {
            imgData.data[d] = srcData[s];
            imgData.data[d + 1] = srcData[s + 1];
            imgData.data[d + 2] = srcData[s + 2];
            imgData.data[d + 3] = 255;
            d += 4;
          }
        } else {
          // Grayscale
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

        if (isNearUniformColor(imgCanvas)) continue;

        // Convert to Blob and compute SHA-256 & dHash
        const blob = await new Promise<Blob | null>(res => imgCanvas.toBlob(res, 'image/jpeg', 0.85));
        if (!blob) continue;

        const buffer = await blob.arrayBuffer();
        const imgSha = await sha256(buffer);
        const dHash = await computeImageDHash(imgCanvas);

        // Deduplication check
        const isDuplicate = images.some(
          ex => ex.sha === imgSha || (ex.duplicateOf && ex.duplicateOf === imgSha)
        );

        const assetId = `img_${String(images.length + 1).padStart(3, '0')}`;
        await saveImageBlob(imgSha, blob);

        // Find nearest source line by y-coordinate on this page
        let anchorLine = lines.find(l => l.page === pageNum)?.id;
        const anchorNum = anchorLine ? parseInt(anchorLine.replace('L', ''), 10) : undefined;

        images.push({
          id: assetId,
          page: pageNum,
          bbox: { x: 0, y: 0, w: imgWidth, h: imgHeight },
          mime: 'image/jpeg',
          sha: imgSha,
          width: imgWidth,
          height: imgHeight,
          anchorLine: anchorNum,
          duplicateOf: isDuplicate ? images.find(e => e.sha === imgSha)?.id : undefined,
          blobKey: imgSha,
          dataUrl: URL.createObjectURL(blob),
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
 * DOCX Extraction using mammoth + JSZip
 */
async function extractDocx(file: File): Promise<ExtractedDocument> {
  const arrayBuffer = await file.arrayBuffer();

  // Extract HTML text
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const html = result.value;

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

    await saveImageBlob(imgSha, blobData);

    images.push({
      id: assetId,
      page: 1,
      bbox: { x: 0, y: 0, w: 400, h: 300 },
      mime,
      sha: imgSha,
      width: 400,
      height: 300,
      blobKey: imgSha,
      dataUrl: URL.createObjectURL(blobData),
    });
  }

  // Convert HTML elements into sequential lines
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  const rawParagraphs: string[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) rawParagraphs.push(text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (['P', 'H1', 'H2', 'H3', 'LI', 'TR'].includes(el.tagName)) {
        const text = el.innerText?.trim();
        if (text) {
          rawParagraphs.push(text);
          return; // skip child recursions since innerText includes them
        }
      }
      for (let c = 0; c < el.childNodes.length; c++) {
        walk(el.childNodes[c]);
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
