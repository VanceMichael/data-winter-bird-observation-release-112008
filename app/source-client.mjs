// 来源客户端：连接两个合作组织的观测接口与许可流。
// 北组织按小队、巡线和时段（游标）查询；东组织按终端上传批分段拉取，
// 迟到的定位附件通过原观测号引用。202 表示该段/附件尚未就绪。

async function getJson(url) {
  const response = await fetch(url);
  if (response.status === 202) {
    return { status: 202, body: await response.json().catch(() => ({ state: 'pending' })) };
  }
  if (!response.ok) {
    throw new Error(`来源请求失败 ${url} -> ${response.status}`);
  }
  return { status: response.status, body: await response.json() };
}

export async function waitForHealth(baseUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    }
    catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`来源服务未就绪 ${baseUrl}: ${lastError?.message ?? 'timeout'}`);
}

// 北组织游标续取，直到 next 为空。
export async function fetchNorth(baseUrl) {
  const pages = [];
  let cursor = 0;
  while (cursor !== null) {
    const { body } = await getJson(`${baseUrl}/north/patrol?cursor=${cursor}`);
    pages.push(body);
    cursor = body.next ?? null;
  }
  return { patrols: pages.flatMap((page) => page.patrols ?? []) };
}

// 东组织：先取批清单，再逐段、逐附件拉取；未就绪的部分保留 pending 标记。
export async function fetchEast(baseUrl) {
  const { body: sets } = await getJson(`${baseUrl}/east/sets`);
  const segments = {};
  const media = {};
  const attachmentPaths = new Set();

  for (const batch of sets) {
    for (const path of batch.segments ?? []) {
      const result = await getJson(`${baseUrl}${path}`);
      segments[path] = result.status === 202 ? { state: 'pending' } : result.body;
      if (result.status === 200) {
        for (const observation of result.body.observations ?? []) {
          if (observation.attachment) attachmentPaths.add(observation.attachment);
        }
      }
    }
  }

  for (const path of attachmentPaths) {
    const result = await getJson(`${baseUrl}${path}`);
    media[path] = result.status === 202 ? { state: 'pending' } : result.body;
  }

  return { sets, segments, media };
}

export async function fetchRegistry(baseUrl) {
  const [links, permissions] = await Promise.all([
    getJson(`${baseUrl}/registry/links`),
    getJson(`${baseUrl}/registry/permissions`),
  ]);
  return { links: links.body, permissions: permissions.body };
}

export async function fetchAreas(baseUrl) {
  const { body } = await getJson(`${baseUrl}/patrol/areas`);
  return body;
}

export async function fetchAcks(baseUrl) {
  const { body } = await getJson(`${baseUrl}/subscribers/acks`);
  return body;
}
