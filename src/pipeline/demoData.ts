/**
 * Built-in Demo Document (§14)
 * Allows instant end-to-end testing of 5 steps, caching, patch regen, and A4 printing without an upload.
 */
import { ExamDoc, ImageAsset, SourceLine } from '../types';
import { sha256 } from '../utils/hash';
import { saveImageBlob } from '../store';

export async function createDemoExamDoc(): Promise<ExamDoc> {
  // Generate a clean circuit/optics diagram for the demo image asset
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 480, 240);

    // Grid lines
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;
    for (let x = 0; x < 480; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 240);
      ctx.stroke();
    }
    for (let y = 0; y < 240; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(480, y);
      ctx.stroke();
    }

    // Circuit Diagram / Spring Mass Oscillator
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;

    // Wall
    ctx.beginPath();
    ctx.moveTo(40, 40);
    ctx.lineTo(40, 200);
    ctx.stroke();
    for (let y = 50; y < 200; y += 15) {
      ctx.beginPath();
      ctx.moveTo(25, y);
      ctx.lineTo(40, y - 10);
      ctx.stroke();
    }

    // Spring
    ctx.beginPath();
    ctx.moveTo(40, 120);
    let sx = 40;
    const segments = 10;
    for (let i = 0; i < segments; i++) {
      const up = i % 2 === 0 ? 95 : 145;
      sx += 20;
      ctx.lineTo(sx, up);
    }
    ctx.lineTo(260, 120);
    ctx.stroke();

    // Mass box
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(260, 80, 80, 80);
    ctx.strokeRect(260, 80, 80, 80);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('m = 2 kg', 270, 127);

    // Surface
    ctx.beginPath();
    ctx.moveTo(20, 160);
    ctx.lineTo(440, 160);
    ctx.stroke();

    // Arrow and Force
    ctx.strokeStyle = '#2563eb';
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.moveTo(340, 120);
    ctx.lineTo(420, 120);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(420, 120);
    ctx.lineTo(405, 112);
    ctx.lineTo(405, 128);
    ctx.fill();

    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('F = 10 N', 360, 105);
    ctx.fillText('k = 200 N/m', 120, 75);
  }

  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.9));
  const buffer = await blob.arrayBuffer();
  const imgSha = await sha256(buffer);
  await saveImageBlob(imgSha, blob);

  const demoImage: ImageAsset = {
    id: 'img_001',
    page: 1,
    bbox: { x: 40, y: 350, w: 480, h: 240 },
    mime: 'image/jpeg',
    sha: imgSha,
    width: 480,
    height: 240,
    anchorLine: 21,
    blobKey: imgSha,
    dataUrl: URL.createObjectURL(blob),
    label: {
      role: 'stem',
      questionRef: '۴',
      kind: 'diagram',
      caption: 'شکل ۱: سامانه جرم و فنر روی سطح افقی بدون اصطکاک',
      needsText: true,
    },
  };

  const rawLinesText = [
    'دبیرستان نمونه دولتی البرز — آزمون نهایی فیزیک و ریاضی دوازدهم',
    'نام و نام خانوادگی: ........................   شماره داوطلب: ...............   مدت آزمون: ۷۵ دقیقه   نمره کل: ۲۰',
    'بخش اول: پرسش‌های چهارگزینه‌ای (هر سوال ۲ نمره)',
    '۱- در یک حرکت نوسانی ساده، در لحظه‌ای که تندی نوسانگر بیشینه است، شتاب آن چگونه است؟',
    'الف) بیشینه است',
    'ب) برابر صفر است',
    'ج) نصف بیشینه است',
    'د) منفی شتاب اولیه است',
    '۲- ضریب شکست شیشه برای نور قرمز ۱.۵۰ و برای نور بنفش ۱.۵۲ است. تندی کدام نور در شیشه بیشتر است؟',
    'الف) نور بنفش',
    'ب) نور قرمز',
    'ج) هر دو برابرند',
    'د) بستگی به زاویه تابش دارد',
    'بخش دوم: سوالات تشریحی و کوتاه پاسخ',
    '۳- جملات زیر را با کلمات مناسب کامل کنید: (۲ نمره)',
    'الف) موج مکانیکی برای انتشار به محیط ........... نیاز دارد.',
    'ب) در پدیده بازتاب نور، زاویه تابش همواره با زاویه ........... برابر است.',
    '۴- با توجه به شکل زیر، جسمی به جرم ۲ کیلوگرم به فنری با ثابت ۲۰۰ متصل است: (۴ نمره)',
    'الف) بسامد زاویه‌ای (ω) نوسان‌ها را به دست آورید.',
    'ب) اگر دامنه نوسان ۵ سانتی‌متر باشد، بیشینه انرژی پتانسیل کشسانی فنر چقدر است؟',
    '۵- درستی یا نادرستی گزاره‌های زیر را مشخص کنید: (۲ نمره)',
    'الف) صوت یک موج طولی است که در خلاء منتشر می‌شود. (ص / غ)',
    'ب) با افزایش فرکانس منبع صوتی در هوا، طول موج کاهش می‌یابد. (ص / غ)',
    'بخش سوم: مسئله محاسباتی نهایی',
    '۶- خودرویی با شتاب ثابت ۲ متر بر مجذور ثانیه از حال سکون به حرکت درمی‌آید: (۶ نمره)',
    'مسافت طی شده در ۱۰ ثانیه اول حرکت را محاسبه کرده و نمودار مکان-زمان آن را رسم نمایید.',
  ];

  const lines: SourceLine[] = rawLinesText.map((text, idx) => ({
    id: `L${String(idx + 1).padStart(4, '0')}`,
    page: 1,
    text,
    y: 800 - idx * 25,
  }));

  const demoDoc: ExamDoc = {
    id: 'demo_exam_fa_001',
    fileHash: 'sha256_built_in_demo_doc',
    createdAt: new Date().toISOString(),
    displayName: 'فیزیک و ریاضی \u2014 پایه دوازدهم ریاضی-فیزیک',
    nameSource: 'ai',
    meta: {
      title: 'آزمون نهایی فیزیک و ریاضی دوازدهم',
      subject: 'فیزیک و ریاضی',
      grade: 'پایه دوازدهم ریاضی-فیزیک',
      school: 'دبیرستان نمونه دولتی البرز',
      term: 'نوبت دوم (خرداد ماه)',
      year: '۱۴۰۴-۱۴۰۵',
      durationMinutes: 75,
      totalPoints: 20,
      language: 'fa',
      direction: 'rtl',
      headerLines: [[1, 2]],
    },
    sections: [
      {
        id: 'sec_1',
        index: 1,
        title: 'بخش اول: پرسش‌های چهارگزینه‌ای',
        instructions: 'هر سوال ۲ نمره دارد. پاسخ صحیح را با علامت مشخص نمایید.',
        spans: [[3, 3]],
      },
      {
        id: 'sec_2',
        index: 2,
        title: 'بخش دوم: سوالات تشریحی و کوتاه پاسخ',
        instructions: 'پاسخ‌ها را به طور کامل و مرتب در فضای مشخص شده بنویسید.',
        spans: [[13, 13]],
      },
      {
        id: 'sec_3',
        index: 3,
        title: 'بخش سوم: مسئله محاسباتی نهایی',
        instructions: 'فرمول‌های به کار رفته الزامی است.',
        spans: [[23, 23]],
      },
    ],
    questions: [
      {
        id: 'q_1',
        label: '۱',
        no: 1,
        sectionId: 'sec_1',
        spans: [[4, 4]],
        stem: 'در یک حرکت نوسانی ساده، در لحظه‌ای که تندی نوسانگر بیشینه است، شتاب آن چگونه است؟',
        points: 2,
        type: 'mcq',
        options: [
          { key: 'الف', spans: [[5, 5]], text: 'بیشینه است' },
          { key: 'ب', spans: [[6, 6]], text: 'برابر صفر است' },
          { key: 'ج', spans: [[7, 7]], text: 'نصف بیشینه است' },
          { key: 'د', spans: [[8, 8]], text: 'منفی شتاب اولیه است' },
        ],
        answer: { spans: [[6, 6]], text: 'گزینه ب (برابر صفر است)', source: 'paper' },
        confidence: 0.98,
        images: [],
      },
      {
        id: 'q_2',
        label: '۲',
        no: 2,
        sectionId: 'sec_1',
        spans: [[9, 9]],
        stem: 'ضریب شکست شیشه برای نور قرمز ۱.۵۰ و برای نور بنفش ۱.۵۲ است. تندی کدام نور در شیشه بیشتر است؟',
        points: 2,
        type: 'mcq',
        options: [
          { key: 'الف', spans: [[10, 10]], text: 'نور بنفش' },
          { key: 'ب', spans: [[11, 11]], text: 'نور قرمز' },
          { key: 'ج', spans: [[12, 12]], text: 'هر دو برابرند' },
          { key: 'د', spans: [[13, 13]], text: 'بستگی به زاویه تابش دارد' },
        ],
        answer: { spans: [[11, 11]], text: 'گزینه ب (نور قرمز)', source: 'paper' },
        confidence: 0.96,
        images: [],
      },
      {
        id: 'q_3',
        label: '۳',
        no: 3,
        sectionId: 'sec_2',
        spans: [[14, 16]],
        stem: 'جملات زیر را با کلمات مناسب کامل کنید:\nالف) موج مکانیکی برای انتشار به محیط ........... نیاز دارد.\nب) در پدیده بازتاب نور، زاویه تابش همواره با زاویه ........... برابر است.',
        points: 2,
        type: 'fillblank',
        answer: { text: 'الف: مادی | ب: بازتاب', source: 'paper' },
        confidence: 0.95,
        images: [],
      },
      {
        id: 'q_4',
        label: '۴',
        no: 4,
        sectionId: 'sec_2',
        spans: [[17, 19]],
        stem: 'با توجه به شکل ۱، جسمی به جرم ۲ کیلوگرم به فنری با ثابت ۲۰۰ نیوتون بر متر متصل است:\nالف) بسامد زاویه‌ای (ω) نوسان‌ها را به دست آورید.\nب) اگر دامنه نوسان ۵ سانتی‌متر باشد، بیشینه انرژی پتانسیل کشسانی فنر چقدر است؟',
        points: 4,
        type: 'diagram',
        answer: { text: 'الف: ω = √(k/m) = 10 rad/s\nب: U_max = 1/2 k A^2 = 1/2 (200)(0.05)^2 = 0.25 J', source: 'paper' },
        confidence: 0.94,
        images: [{ imageId: 'img_001', role: 'stem', anchorLine: 21 }],
      },
      {
        id: 'q_5',
        label: '۵',
        no: 5,
        sectionId: 'sec_2',
        spans: [[20, 22]],
        stem: 'درستی یا نادرستی گزاره‌های زیر را مشخص کنید:\nالف) صوت یک موج طولی است که در خلاء منتشر می‌شود.\nب) با افزایش فرکانس منبع صوتی در هوا، طول موج کاهش می‌یابد.',
        points: 2,
        type: 'truefalse',
        answer: { text: 'الف: نادرست (غلط)\nب: درست (صحیح)', source: 'paper' },
        confidence: 0.95,
        images: [],
      },
      {
        id: 'q_6',
        label: '۶',
        no: 6,
        sectionId: 'sec_3',
        spans: [[24, 25]],
        stem: 'خودرویی با شتاب ثابت ۲ متر بر مجذور ثانیه از حال سکون به حرکت درمی‌آید:\nمسافت طی شده در ۱۰ ثانیه اول حرکت را محاسبه کرده و نمودار مکان-زمان آن را رسم نمایید.',
        points: 8,
        type: 'long',
        answer: { text: 'x = 1/2 a t^2 = 1/2 (2)(10)^2 = 100 m', source: 'paper' },
        confidence: 0.92,
        images: [],
      },
    ],
    images: [demoImage],
    source: {
      lines,
      pages: 1,
      ocrUsed: false,
      fileName: 'Physics_Grade12_Alborz_FinalExam.pdf',
      pageImages: [demoImage.dataUrl!],
    },
    flags: [],
    usage: [
      {
        ts: new Date().toISOString(),
        role: 'fast',
        provider: 'Google Gemini',
        model: 'gemini-2.5-flash-lite',
        inputTokens: 520,
        outputTokens: 78,
        costUsd: 0.000062,
        label: 'Structure Pass',
        isCachedHit: false,
      },
      {
        ts: new Date().toISOString(),
        role: 'vision',
        provider: 'Google Gemini',
        model: 'gemini-2.5-flash',
        inputTokens: 258,
        outputTokens: 42,
        costUsd: 0.000064,
        label: 'Vision Labeling (1 image)',
        isCachedHit: false,
      },
    ],
  };

  return demoDoc;
}
