import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTestDb, makeEnv, worker } from './helpers.js';

const CANONICAL = 'https://cheaprides.406truckdrops.com';

function readPublic(rel) {
  return readFileSync(new URL('../public/' + rel, import.meta.url), 'utf8');
}

function htmlPages() {
  const root = fileURLToPath(new URL('../public/', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.html')) files.push(path);
    }
  };
  walk(root);
  return files;
}

test('public pages share the nav, canonical host, and social tags', () => {
  const pages = htmlPages();
  assert.ok(pages.length >= 8);
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    assert.match(html, /aria-label="Primary"/, file);
    assert.match(html, /href="\/#deals"/, file);
    assert.match(html, /href="\/categories"/, file);
    assert.match(html, /href="\/pricing"/, file);
    assert.match(html, /href="\/account"/, file);
    assert.match(html, /Start free trial/, file);
    assert.match(html, /href="\/terms"/, file);
    assert.match(html, /href="\/privacy"/, file);
    assert.match(html, /mailto:support@406truckdrops\.com/, file);
    assert.match(html, new RegExp('rel="canonical" href="' + CANONICAL.replace(/\./g, '\\.')), file);
    assert.match(html, /property="og:title"/, file);
    assert.match(html, /property="og:description"/, file);
    assert.match(html, /property="og:image"/, file);
    assert.match(html, /name="twitter:card"/, file);
    assert.match(html, /name="theme-color"/, file);
    assert.match(html, /<title>[^<]+<\/title>/, file);
    assert.match(html, /name="description"/, file);
  }
  const pricing = readPublic('pricing/index.html');
  assert.match(pricing, /"@type": "FAQPage"/);
  assert.match(pricing, /"@type": "Offer"/);
  assert.match(pricing, /"price": "7"/);
  assert.match(pricing, /"price": "49"/);
  const questions = pricing.match(/"@type": "Question"/g) || [];
  assert.ok(questions.length >= 5 && questions.length <= 8);
  const home = readPublic('index.html');
  assert.match(home, /"@type": "Organization"/);
  assert.match(home, /"@type": "WebSite"/);
});

test('robots, sitemap, and llms files are served with the right types', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  env.ASSETS = {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      try {
        const body = readFileSync(new URL('../public/' + path, import.meta.url));
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      } catch {
        return new Response('missing', { status: 404 });
      }
    },
  };

  const robots = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/robots.txt'), env);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /User-agent: GPTBot/);
  assert.match(robotsBody, /User-agent: ClaudeBot/);
  assert.match(robotsBody, /User-agent: PerplexityBot/);
  assert.match(robotsBody, /User-agent: Google-Extended/);
  assert.match(robotsBody, /User-agent: CCBot/);
  assert.match(robotsBody, /Disallow: \/api\//);
  assert.match(robotsBody, /Disallow: \/account/);
  assert.match(robotsBody, /Sitemap: https:\/\/cheaprides\.406truckdrops\.com\/sitemap\.xml/);

  const sitemap = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/sitemap.xml'), env);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /xml/);
  const map = await sitemap.text();
  assert.match(map, /https:\/\/cheaprides\.406truckdrops\.com\/pricing/);
  assert.match(map, /https:\/\/cheaprides\.406truckdrops\.com\/categories/);
  assert.doesNotMatch(map, /\/account/);

  const llms = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/llms.txt'), env);
  assert.equal(llms.status, 200);
  assert.match(llms.headers.get('content-type'), /text\/plain/);
  const brief = await llms.text();
  assert.match(brief, /\$7 per month/);
  assert.match(brief, /\$49 per year/);
  assert.match(brief, /Billings/);
  assert.match(brief, /Beater commuters/);

  const full = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/llms-full.txt'), env);
  assert.equal(full.status, 200);
  assert.match(await full.text(), /24 hours/);

  const missing = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/no-such-page'), env);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /text\/html/);
  assert.match(await missing.text(), /Page not found/);
});
