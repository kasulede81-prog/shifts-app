import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ProfileStore } from '../www/store.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  async getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async setItem(key, value) {
    this.map.set(key, value);
    return true;
  }

  async removeItem(key) {
    this.map.delete(key);
    return true;
  }
}

async function waitFor(predicate, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

function installDom(dom) {
  const names = [
    'window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event',
    'CustomEvent', 'Blob', 'URL', 'localStorage', 'confirm'
  ];
  const previous = new Map();
  const install = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    Blob: dom.window.Blob,
    URL: dom.window.URL,
    localStorage: dom.window.localStorage,
    confirm: () => true
  };
  for (const name of names) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: install[name]
    });
  }
  return () => {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

test('dashboard initializes after unlock, opens a profile, adds and deletes one profile without touching the seed', async () => {
  const html = await readFile(new URL('../www/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html.replace(/<script\b[^>]*><\/script>/gi, ''), {
    url: 'https://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const restoreGlobals = installDom(dom);
  let app = null;
  try {
    const { initApp } = await import('../www/app.js');
    const store = new ProfileStore(new MemoryStorage(), {
      now: () => new Date('2026-10-22T08:00:00.000Z')
    });
    await store.load();
    app = await initApp({ store, storageLabel: 'test storage' });

    assert.equal(dom.window.document.getElementById('appRoot').style.display, 'block');
    assert.equal(dom.window.document.getElementById('profilePicker').classList.contains('hidden'), false);
    const choices = [...dom.window.document.querySelectorAll('.profile-choice')];
    assert.equal(choices.length, 1);
    assert.match(choices[0].textContent, /Andrew Wamani/);

    choices[0].click();
    await waitFor(
      () => dom.window.document.querySelector('#dashName')?.textContent === 'Andrew Wamani',
      'the Andrew dashboard to render'
    );
    assert.equal(dom.window.document.getElementById('activeProfilePanel').classList.contains('hidden'), false);
    assert.ok(dom.window.document.querySelector('#primaryTimezone'));
    assert.ok(dom.window.document.querySelector('#shiftDate'));
    assert.equal(dom.window.document.querySelectorAll('#savedSchedule .day').length, 6);

    dom.window.document.getElementById('addTopButton').click();
    dom.window.document.getElementById('pName').value = 'Temporary Worker';
    dom.window.document.getElementById('pAddress').value = '99 Test Avenue';
    dom.window.document.getElementById('pSchedules').value = '2026-10-25,22:00,06:00';
    dom.window.document.getElementById('saveProfileButton').click();
    await waitFor(
      () => store.listProfiles().some((profile) => profile.name === 'Temporary Worker'),
      'the new profile to be persisted'
    );
    await waitFor(
      () => dom.window.document.querySelector('#dashName')?.textContent === 'Temporary Worker',
      'the new profile dashboard to render'
    );
    assert.equal(store.listProfiles().length, 2);
    assert.equal(store.listProfiles().find((profile) => profile.name === 'Temporary Worker').schedules['2026-10-25'].end, '06:00');

    dom.window.document.getElementById('deleteActiveButton').click();
    await waitFor(
      () => store.listProfiles().length === 1,
      'the temporary profile to be deleted'
    );
    await waitFor(
      () => dom.window.document.getElementById('profilePicker').classList.contains('hidden') === false,
      'the profile picker after deletion'
    );
    const remaining = store.listProfiles();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].name, 'Andrew Wamani');
    assert.equal(Object.keys(remaining[0].schedules).length, 6);
  } finally {
    app?.destroy();
    dom.window.close();
    restoreGlobals();
  }
});
