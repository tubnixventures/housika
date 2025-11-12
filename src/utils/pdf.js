import puppeteer from 'puppeteer';

let browser, setupError, setupPromise;

const ensureBrowserReady = async () => {
  if (setupError) throw setupError;
  if (browser) return;

  if (!setupPromise) {
    setupPromise = puppeteer
      .launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 1280, height: 800 },
      })
      .then(b => (browser = b))
      .catch(err => {
        setupError = new Error(`Puppeteer launch failed: ${err.message}`);
      });
  }

  await setupPromise;
  if (setupError) throw setupError;
};

export async function htmlToPdfBuffer(html) {
  if (!html?.trim()) throw new Error('HTML input is empty or invalid.');
  await ensureBrowserReady();

  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '40px', bottom: '40px', left: '30px', right: '30px' },
    });
  } catch (err) {
    console.error('❌ PDF generation failed:', err);
    throw new Error('PDF generation failed.');
  } finally {
    await page.close();
  }
}
