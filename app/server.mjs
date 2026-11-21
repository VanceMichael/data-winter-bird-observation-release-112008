// 本地应用 HTTP 服务。
// /internal/* 供巡护办公室使用：看合作方明细、缺口原因、人工提示与历轮证据；
// /public/* 是公开出口：只有合成粒度下的目录、订阅流与撤回通知。
// 内部凭据查询也不能恢复已撤的公开定位：公开数据一律从发布流水重建。

import { createServer } from 'node:http';
import { syncOnce } from './sync.mjs';
import { publicCatalog, publicFeed } from './release.mjs';
import { licenseForItem } from './permissions.mjs';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function send(response, status, value) {
  response.writeHead(status, jsonHeaders);
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      }
      catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function pendingWithdrawals(ledger) {
  const ackThrough = new Map(ledger.acks.map((ack) => [ack.subscriber, ack.through]));
  const withdrawals = ledger.releases.filter((entry) => entry.kind === 'withdrawal');
  return [...ackThrough.entries()].map(([subscriber, through]) => ({
    subscriber,
    ackThrough: through,
    undelivered: withdrawals
      .filter((entry) => entry.sequence > through)
      .map((entry) => ({ sequence: entry.sequence, ref: entry.ref, reason: entry.reason })),
  })).filter((row) => row.undelivered.length > 0);
}

function internalObservation(ledger, item, asOf) {
  const observation = ledger.observations.get(item);
  if (!observation) return null;
  const license = licenseForItem(ledger.permissions, item, asOf);
  const group = [...ledger.groups.values()].find((g) => g.members.includes(item));
  return {
    ...observation,
    versions: observation.versions,
    publicUse: {
      usable: license.usable,
      reason: license.reason,
      embargoUntil: license.embargoUntil,
      grain: license.grain,
    },
    event: group?.event ?? null,
  };
}

export function createApp(ledger, sourceBase) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/health') {
        send(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'POST' && path === '/internal/sync') {
        const body = await readBody(request);
        const result = await syncOnce(ledger, sourceBase, {
          stage: body.stage,
          asOf: body.asOf,
        });
        send(response, 200, {
          round: result.round,
          asOf: result.asOf,
          newEntries: result.entries.map((entry) => ({
            sequence: entry.sequence,
            kind: entry.kind,
            key: entry.key,
            reason: entry.reason ?? null,
          })),
        });
        return;
      }

      if (request.method === 'GET' && path === '/internal/coverage') {
        send(response, 200, ledger.coverage);
        return;
      }

      if (request.method === 'GET' && path === '/internal/facts') {
        send(response, 200, ledger.facts);
        return;
      }

      if (request.method === 'GET' && path === '/internal/observations') {
        const asOf = url.searchParams.get('asOf') ?? ledger.rounds.at(-1)?.at ?? new Date().toISOString();
        send(response, 200, [...ledger.observations.keys()]
          .map((item) => internalObservation(ledger, item, asOf)));
        return;
      }

      const observationMatch = path.match(/^\/internal\/observations\/(.+)$/);
      if (request.method === 'GET' && observationMatch) {
        const asOf = url.searchParams.get('asOf') ?? ledger.rounds.at(-1)?.at ?? new Date().toISOString();
        const detail = internalObservation(ledger, decodeURIComponent(observationMatch[1]), asOf);
        send(response, detail ? 200 : 404, detail ?? { error: '未找到该观测' });
        return;
      }

      if (request.method === 'GET' && path === '/internal/links') {
        send(response, 200, {
          verified: [...ledger.groups.values()],
          manualCandidates: ledger.manualCandidates,
        });
        return;
      }

      if (request.method === 'GET' && path === '/internal/rounds') {
        send(response, 200, ledger.rounds);
        return;
      }

      const roundMatch = path.match(/^\/internal\/rounds\/(\d+)$/);
      if (request.method === 'GET' && roundMatch) {
        const round = ledger.rounds[Number(roundMatch[1]) - 1];
        send(response, round ? 200 : 404, round ?? { error: '未找到该轮证据' });
        return;
      }

      if (request.method === 'GET' && path === '/internal/duty/withdrawals') {
        send(response, 200, pendingWithdrawals(ledger));
        return;
      }

      if (request.method === 'GET' && path === '/public/catalog') {
        // 从发布流水重建；已撤条目的旧定位不会出现在这里。
        send(response, 200, publicCatalog(ledger.releases));
        return;
      }

      if (request.method === 'GET' && path === '/public/feed') {
        const from = Number(url.searchParams.get('from') ?? 0);
        if (!Number.isInteger(from) || from < 0) {
          send(response, 400, { error: 'from 必须是非负整数发布号' });
          return;
        }
        send(response, 200, {
          next: ledger.sequence,
          entries: publicFeed(ledger.releases, from),
        });
        return;
      }

      if (request.method === 'GET' && path === '/public/withdrawals') {
        send(response, 200, ledger.releases
          .filter((entry) => entry.kind === 'withdrawal')
          .map((entry) => ({ sequence: entry.sequence, ref: entry.ref, reason: entry.reason })));
        return;
      }

      send(response, 404, { error: '没有这条路径' });
    }
    catch (error) {
      send(response, 500, { error: error.message });
    }
  });
}
