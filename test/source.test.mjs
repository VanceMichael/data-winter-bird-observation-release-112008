import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';

const data = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url)));
const probes = JSON.parse(readFileSync(new URL('../fixtures/probes.json', import.meta.url)));

test('本地来源按阶段返回原始记录', async (context) => {
  const server = createSource();
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const step of data.steps) {
    const selected = await fetch(`${base}/_source_clock?step=${step}`, { method: 'PUT' });
    assert.equal(selected.status, 200);
    await selected.json();
    for (const [key, route] of Object.entries({ ...data.routes.common, ...data.routes[step] })) {
      const [method, path] = key.split(' ');
      const actual = await fetch(base + path, { method, redirect: 'manual' });
      assert.equal(actual.status, route.status ?? (route.body === undefined ? 204 : 200), key);
      if (route.type && route.body !== undefined) {
        const expected = (route.formFields ?? []).reduce((html, name) => html.replaceAll('{{' + name + '}}', ''), route.body);
        assert.equal(await actual.text(), expected, key);
      }
      else if (route.body !== undefined) assert.deepEqual(await actual.json(), route.body, key);
    }
  }

  for (const probe of probes) {
    const setup = await fetch(`${base}/_source_clock?step=${probe.step}`, { method: 'PUT' });
    await setup.json();
    const response = await fetch(base + probe.path, { method: probe.method ?? 'GET', redirect: 'manual' });
    const body = await response.text();
    const value = probe.field ? probe.field.reduce((item, field) => item[field], JSON.parse(body)) : body;
    assert.equal(value, probe.value, probe.path);
  }

  const calls = await (await fetch(base + '/_source_calls')).json();
  assert.ok(calls.some((call) => call.step === data.steps.at(-1)));
  assert.equal((await fetch(base + '/not-a-provider-path')).status, 404);
});
