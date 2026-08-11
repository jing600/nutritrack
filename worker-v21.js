const encoder = new TextEncoder();

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders()
  });
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(message) {
  return await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(message)
  );
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message)
  );
}

function normalizeSyncCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function syncCodeToUserId(code) {
  const normalized = normalizeSyncCode(code);

  if (!normalized.startsWith("NT") || normalized.length < 14) {
    throw new Error("同步码格式无效");
  }

  return bytesToHex(
    await sha256(`NUTRITRACK-V1|${normalized}`)
  );
}

async function saveUserData(request, env) {
  if (!env.DB) {
    return jsonResponse({
      ok: false,
      error: "D1 数据库 DB 尚未绑定"
    }, 500);
  }

  const input = await request.json();
  const syncCode = String(input?.syncCode || "");
  const displayName = String(input?.displayName || "用户")
    .trim()
    .slice(0, 50);
  const data = input?.data;

  if (!data || typeof data !== "object") {
    return jsonResponse({
      ok: false,
      error: "缺少有效 data"
    }, 400);
  }

  const userId = await syncCodeToUserId(syncCode);
  const updatedAt = Date.now();

  const payload = {
    ...data,
    cloudProfile: {
      ...(data.cloudProfile || {}),
      displayName
    }
  };

  const dataJson = JSON.stringify(payload);

  if (dataJson.length > 1_500_000) {
    return jsonResponse({
      ok: false,
      error: "云端数据过大"
    }, 413);
  }

  await env.DB
    .prepare(`
      INSERT INTO user_data (user_id, data_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id)
      DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `)
    .bind(userId, dataJson, updatedAt)
    .run();

  return jsonResponse({
    ok: true,
    updatedAt
  });
}

async function loadUserData(request, env) {
  if (!env.DB) {
    return jsonResponse({
      ok: false,
      error: "D1 数据库 DB 尚未绑定"
    }, 500);
  }

  const input = await request.json();
  const syncCode = String(input?.syncCode || "");
  const userId = await syncCodeToUserId(syncCode);

  const row = await env.DB
    .prepare(`
      SELECT data_json, updated_at
      FROM user_data
      WHERE user_id = ?
      LIMIT 1
    `)
    .bind(userId)
    .first();

  if (!row) {
    return jsonResponse({
      ok: false,
      error: "没有找到这个同步码对应的云端用户"
    }, 404);
  }

  let data = {};

  try {
    data = JSON.parse(row.data_json || "{}");
  } catch {
    return jsonResponse({
      ok: false,
      error: "云端数据格式异常"
    }, 500);
  }

  return jsonResponse({
    ok: true,
    data,
    displayName: data?.cloudProfile?.displayName || "云用户",
    updatedAt: Number(row.updated_at) || 0
  });
}

async function callTencentOCR(imageBase64, env) {
  const secretId = env.TENCENT_SECRET_ID;
  const secretKey = env.TENCENT_SECRET_KEY;

  if (!secretId || !secretKey) {
    throw new Error(
      "Cloudflare Worker 中没有找到 TENCENT_SECRET_ID 或 TENCENT_SECRET_KEY"
    );
  }

  const service = "ocr";
  const host = "ocr.tencentcloudapi.com";
  const endpoint = `https://${host}`;
  const action = "GeneralAccurateOCR";
  const version = "2018-11-19";
  const algorithm = "TC3-HMAC-SHA256";

  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000)
    .toISOString()
    .slice(0, 10);

  const payload = JSON.stringify({
    ImageBase64: imageBase64
  });

  const hashedPayload = bytesToHex(
    await sha256(payload)
  );

  const canonicalHeaders =
    "content-type:application/json; charset=utf-8\n" +
    `host:${host}\n` +
    `x-tc-action:${action.toLowerCase()}\n`;

  const signedHeaders =
    "content-type;host;x-tc-action";

  const canonicalRequest =
    "POST\n" +
    "/\n" +
    "\n" +
    canonicalHeaders +
    "\n" +
    signedHeaders +
    "\n" +
    hashedPayload;

  const credentialScope =
    `${date}/${service}/tc3_request`;

  const hashedCanonicalRequest =
    bytesToHex(
      await sha256(canonicalRequest)
    );

  const stringToSign =
    `${algorithm}\n` +
    `${timestamp}\n` +
    `${credentialScope}\n` +
    `${hashedCanonicalRequest}`;

  const secretDate = await hmacSha256(
    `TC3${secretKey}`,
    date
  );

  const secretService = await hmacSha256(
    secretDate,
    service
  );

  const secretSigning = await hmacSha256(
    secretService,
    "tc3_request"
  );

  const signature = bytesToHex(
    await hmacSha256(
      secretSigning,
      stringToSign
    )
  );

  const authorization =
    `${algorithm} ` +
    `Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": authorization,
      "Content-Type": "application/json; charset=utf-8",
      "Host": host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version
    },
    body: payload
  });

  const result = await response.json();

  return {
    httpStatus: response.status,
    result
  };
}

function normalizeTencentResult(result) {
  const response = result?.Response;

  if (!response) {
    return {
      ok: false,
      error: "腾讯云没有返回有效 Response"
    };
  }

  if (response.Error) {
    return {
      ok: false,
      error: {
        code: response.Error.Code,
        message: response.Error.Message
      },
      requestId: response.RequestId
    };
  }

  const detections = Array.isArray(response.TextDetections)
    ? response.TextDetections
    : [];

  const text = detections
    .map(item => item.DetectedText || "")
    .filter(Boolean)
    .join("\n");

  return {
    ok: true,
    text,
    detections,
    angle:
      response.Angle !== undefined
        ? response.Angle
        : null,
    requestId:
      response.RequestId || ""
  };
}

async function handleOCR(request, env) {
  let input;

  try {
    input = await request.json();
  } catch {
    return jsonResponse({
      ok: false,
      error: "请求不是有效 JSON"
    }, 400);
  }

  let imageBase64 =
    String(input?.imageBase64 || "").trim();

  if (!imageBase64) {
    return jsonResponse({
      ok: false,
      error: "缺少 imageBase64"
    }, 400);
  }

  if (imageBase64.startsWith("data:")) {
    const comma = imageBase64.indexOf(",");
    if (comma !== -1) {
      imageBase64 = imageBase64.slice(comma + 1);
    }
  }

  if (imageBase64.length > 13_000_000) {
    return jsonResponse({
      ok: false,
      error: "图片太大，请先压缩或裁剪"
    }, 413);
  }

  const tencent =
    await callTencentOCR(imageBase64, env);

  const normalized =
    normalizeTencentResult(tencent.result);

  if (!normalized.ok) {
    return jsonResponse({
      ...normalized,
      tencentHttpStatus:
        tencent.httpStatus
    }, 502);
  }

  return jsonResponse({
    ok: true,
    provider: "Tencent Cloud OCR",
    model: "GeneralAccurateOCR",
    text: normalized.text,
    detections: normalized.detections,
    angle: normalized.angle,
    requestId: normalized.requestId
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && path === "/") {
        return jsonResponse({
          ok: true,
          service: "NutriTrack Worker",
          ocr: "GeneralAccurateOCR",
          d1: Boolean(env.DB),
          version: "V21",
          status: "ready"
        });
      }

      if (request.method === "POST" && path === "/data/save") {
        return await saveUserData(request, env);
      }

      if (request.method === "POST" && path === "/data/load") {
        return await loadUserData(request, env);
      }

      // Backward compatible: NutriTrack sends OCR to POST /
      if (request.method === "POST" && (path === "/" || path === "/ocr")) {
        return await handleOCR(request, env);
      }

      return jsonResponse({
        ok: false,
        error: "接口不存在"
      }, 404);

    } catch (error) {
      console.error("NutriTrack Worker error:", error);

      return jsonResponse({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  }
};
