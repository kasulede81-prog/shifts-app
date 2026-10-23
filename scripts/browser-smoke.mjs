import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = join(projectRoot, 'dist');
const artifacts = join(projectRoot, 'artifacts');
const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const chromePath = browserCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  throw new Error('Chrome or Edge was not found. Set CHROME_PATH to run the browser smoke test.');
}
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const candidate = resolve(distRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!candidate.startsWith(distRoot)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const data = await readFile(candidate);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(candidate)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(data);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

await mkdir(artifacts, { recursive: true });
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/`;

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 360, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('request', (request) => {
  const requestUrl = new URL(request.url());
  if (requestUrl.origin !== new URL(baseUrl).origin && requestUrl.protocol !== 'data:') {
    externalRequests.push(request.url());
  }
});

const firstPin = '864209';

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pinConfirm', { state: 'visible' });
  assert.match(await page.textContent('#pinTitle'), /Create your app PIN/);
  assert.equal(await page.textContent('#pinSubmit'), 'Create PIN');
  await page.screenshot({ path: join(artifacts, 'ui-pin-setup.png'), fullPage: true });

  await page.fill('#pinInput', firstPin);
  await page.fill('#pinConfirm', firstPin);
  await page.click('#pinSubmit');
  await page.waitForSelector('#profilePicker:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('pinGate').style.display === 'none');
  assert.match(await page.textContent('#pinTitle'), /Unlock shift dashboard/);
  const pickerDisplay = await page.$eval('#appRoot', (element) => getComputedStyle(element).display);
  assert.equal(pickerDisplay, 'block');
  const profileButtons = page.locator('.profile-choice');
  assert.equal(await profileButtons.count(), 1);
  assert.match(await profileButtons.first().textContent(), /Andrew Wamani/);
  await page.screenshot({ path: join(artifacts, 'ui-profile-picker.png'), fullPage: true });

  await profileButtons.first().click();
  await page.waitForSelector('#dashName');
  assert.equal(await page.textContent('#dashName'), 'Andrew Wamani');
  assert.equal(await page.locator('#savedSchedule .day').count(), 6);
  await page.locator('#shiftDate').fill('2026-10-22');
  await page.locator('#shiftDate').dispatchEvent('change');
  await page.locator('#primaryTimezone').selectOption('Europe/Rome');
  await page.waitForFunction(() => document.getElementById('shiftHoursValue')?.textContent === '04:00–14:00');
  await page.screenshot({ path: join(artifacts, 'ui-dashboard.png'), fullPage: true });

  const pinStorage = await page.evaluate(() => Object.fromEntries(
    Object.keys(localStorage)
      .filter((key) => key.toLowerCase().includes('pin'))
      .map((key) => [key, localStorage.getItem(key)])
  ));
  assert.ok(Object.keys(pinStorage).length > 0, 'PIN hash should be stored');
  assert.equal(Object.values(pinStorage).some((value) => value.includes(firstPin)), false);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pinInput:not([disabled])');
  assert.match(await page.textContent('#pinTitle'), /Unlock shift dashboard/);
  await page.fill('#pinInput', firstPin);
  await page.click('#pinSubmit');
  await page.waitForSelector('#profilePicker:not(.hidden)', { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('pinGate').style.display === 'none');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('pinGate')).display === 'flex');
  assert.equal(await page.$eval('#appRoot', (element) => getComputedStyle(element).display), 'none');
  assert.match(await page.textContent('#pinHelp'), /resume/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.fill('#pinInput', firstPin);
  await page.click('#pinSubmit');
  await page.waitForFunction(() => document.getElementById('pinGate').style.display === 'none');
  assert.equal(await page.isVisible('#profilePicker'), true);
  assert.equal(await page.locator('#dashName').count(), 0);

  await page.click('#profilesTopButton');
  await page.click('#backupButton');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBackupButton')
  ]);
  const downloadPath = join(artifacts, 'browser-smoke-backup.json');
  await download.saveAs(downloadPath);
  const backup = JSON.parse(await readFile(downloadPath, 'utf8'));
  assert.equal(backup.format, 'DKASUShiftDashboardBackup');
  assert.equal(backup.version, 2);
  assert.equal(backup.profiles.length, 1);
  assert.equal(backup.profiles[0].name, 'Andrew Wamani');
  assert.equal(Object.keys(backup.profiles[0].schedules).length, 6);

  await page.click('#addTopButton');
  await page.fill('#pName', 'Restore Test Worker');
  await page.fill('#pAddress', '1 Restore Test Road');
  await page.fill('#pSchedules', '2026-10-30,06:00,16:00');
  await page.click('#saveProfileButton');
  await page.waitForFunction(() => document.querySelector('#dashName')?.textContent === 'Restore Test Worker');
  await page.click('#profilesTopButton');
  await page.click('#backupButton');
  page.once('dialog', (dialog) => dialog.accept());
  await page.setInputFiles('#backupFileInput', downloadPath);
  await page.waitForFunction(() => document.querySelectorAll('.profile-choice').length === 1);
  assert.match(await page.textContent('.profile-choice'), /Andrew Wamani/);
  assert.match(await page.textContent('#appMessage'), /Restore complete/);

  const invalidBackupPath = join(artifacts, 'browser-invalid-backup.json');
  await writeFile(invalidBackupPath, JSON.stringify({
    format: 'DKASUShiftDashboardBackup',
    version: 2,
    exportedAt: new Date().toISOString(),
    profiles: [{ id: 'invalid', name: 17 }]
  }), 'utf8');
  await page.click('#backupButton');
  await page.setInputFiles('#backupFileInput', invalidBackupPath);
  await page.waitForFunction(() => /Restore failed/.test(document.getElementById('backupStatus')?.textContent || ''));
  assert.equal(await page.locator('.profile-choice').count(), 1);
  assert.match(await page.textContent('.profile-choice'), /Andrew Wamani/);

  const exportChoices = await page.locator('#profileExportSelect option').allTextContents();
  assert.equal(exportChoices.length, 1);
  assert.match(exportChoices[0], /Andrew Wamani/);
  const [workerDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportWorkerProfileButton')
  ]);
  const workerPackagePath = join(artifacts, 'browser-smoke-worker-profile.json');
  await workerDownload.saveAs(workerPackagePath);
  const workerPackage = JSON.parse(await readFile(workerPackagePath, 'utf8'));
  assert.equal(workerPackage.format, 'DKASUShiftWorkerProfile');
  assert.equal(workerPackage.version, 1);
  assert.equal(workerPackage.profile.name, 'Andrew Wamani');
  assert.equal(workerPackage.profile.swipeId, 'ID55911');
  assert.equal(Object.keys(workerPackage.profile.schedules).length, 6);
  assert.equal(Object.hasOwn(workerPackage.profile, 'confirmations'), false);
  assert.equal(JSON.stringify(workerPackage).includes('confirmedAt'), false);
  assert.equal(JSON.stringify(workerPackage).includes('"pin"'), false);
  await page.screenshot({ path: join(artifacts, 'ui-worker-handoff.png'), fullPage: true });

  await page.setInputFiles('#workerProfileFileInput', workerPackagePath);
  await page.waitForFunction(() => /already on this phone/.test(document.getElementById('backupStatus')?.textContent || ''));
  assert.equal(await page.locator('.profile-choice').count(), 1);

  const invalidWorkerPath = join(artifacts, 'browser-invalid-worker-package.json');
  const invalidWorkerPackage = structuredClone(workerPackage);
  invalidWorkerPackage.profile.name = 17;
  await writeFile(invalidWorkerPath, JSON.stringify(invalidWorkerPackage, null, 2), 'utf8');
  await page.setInputFiles('#workerProfileFileInput', invalidWorkerPath);
  await page.waitForFunction(() => /Profile import failed/.test(document.getElementById('backupStatus')?.textContent || ''));
  assert.equal(await page.locator('.profile-choice').count(), 1);

  workerPackage.profile.id = 'worker_handoff_test';
  workerPackage.profile.name = 'Handoff Worker';
  workerPackage.profile.profileId = 'ID-HANDOFF-TEST';
  workerPackage.profile.swipeId = 'SW-HANDOFF-TEST';
  workerPackage.exportedAt = new Date().toISOString();
  const handoffPath = join(artifacts, 'browser-handoff-worker.json');
  await writeFile(handoffPath, JSON.stringify(workerPackage, null, 2), 'utf8');
  page.once('dialog', (dialog) => dialog.accept());
  await page.setInputFiles('#workerProfileFileInput', handoffPath);
  await page.waitForSelector('#profilePicker:not(.hidden)');
  assert.match(await page.textContent('#appMessage'), /Handoff Worker was added/);
  const profileChoicesAfterImport = page.locator('.profile-choice');
  assert.equal(await profileChoicesAfterImport.count(), 2);
  assert.match(await profileChoicesAfterImport.allTextContents().then((items) => items.join(' ')), /Andrew Wamani/);
  assert.match(await profileChoicesAfterImport.allTextContents().then((items) => items.join(' ')), /Handoff Worker/);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pinInput:not([disabled])');
  const wrongPin = '000000';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.fill('#pinInput', wrongPin);
    await page.click('#pinSubmit');
    if (attempt < 5) {
      await page.waitForFunction(() => (
        /Incorrect PIN/.test(document.getElementById('pinError')?.textContent || '')
        && !document.getElementById('pinSubmit').disabled
      ));
    }
  }
  await page.waitForFunction(() => (
    /Too many incorrect attempts/.test(document.getElementById('pinError')?.textContent || '')
    && document.getElementById('pinSubmit').disabled
  ));
  assert.equal(await page.isDisabled('#pinInput'), true);
  await page.screenshot({ path: join(artifacts, 'ui-pin-locked.png'), fullPage: true });

  await writeFile(join(artifacts, 'browser-smoke-result.json'), JSON.stringify({
    setupPin: 'passed',
    unlockAndPicker: 'passed',
    dashboardAndTimezone: 'passed',
    pinNotStoredInPlaintext: 'passed',
    reloadRequiresPin: 'passed',
    resumeRequiresPin: 'passed',
    browserBackupDownload: 'passed',
    browserBackupRestore: 'passed',
    invalidRestoreDidNotChangeData: 'passed',
    workerPackageExport: 'passed',
    duplicateWorkerImportRejected: 'passed',
    invalidWorkerPackageRejected: 'passed',
    additiveWorkerImport: 'passed',
    pinLockoutAfterFiveFailures: 'passed',
    noExternalRequests: 'passed',
    pageErrors,
    consoleErrors,
    externalRequests
  }, null, 2));

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log('Browser smoke test passed: PIN setup/unlock/lockout, picker, dashboard, DST display, reload lock, full backup, worker package export/duplicate/additive import, invalid-restore safety, no external requests.');
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
