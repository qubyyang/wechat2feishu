#!/usr/bin/env node
/**
 * 导出前的连通性自检：确认微信后台登录态是否有效、/cgi-bin/appmsgpublish 是否仍在限流。
 *
 * 用法：npm run probe:wechat -- [fakeid]
 * 需要 Node >= 20.6（依赖 --env-file 读取 .env）
 */
const cookie = process.env.W2F_WECHAT_MP_COOKIE ?? "";
const token = process.env.W2F_WECHAT_MP_TOKEN ?? "";
const fakeid = process.argv[2]?.trim();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const RET_TEXT = {
  200003: "登录态失效，重新登录后台后更新 .env",
  200013: "频率限制（freq control），需等待冷却"
};

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!token || !cookie) {
  fail("缺少 W2F_WECHAT_MP_TOKEN / W2F_WECHAT_MP_COOKIE，请检查 .env。");
}

async function get(path, params) {
  const url = new URL(`https://mp.weixin.qq.com${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { cookie, referer: "https://mp.weixin.qq.com/", "user-agent": UA }
  });

  return { json: await response.json().catch(() => null), status: response.status };
}

console.log(`token = ${token.slice(0, 4)}…（已脱敏），cookie 长度 = ${cookie.length}`);

// 1) 登录态检查：searchbiz 与 appmsgpublish 同属后台接口，但频控配额相互独立
const { json: searched } = await get("/cgi-bin/searchbiz", {
  action: "search_biz",
  ajax: "1",
  begin: "0",
  count: "5",
  f: "json",
  lang: "zh_CN",
  query: "test",
  token
});
const sessionRet = searched?.base_resp?.ret;

if (sessionRet !== 0) {
  fail(
    `登录态无效：searchbiz 返回 ret=${sessionRet} ${searched?.base_resp?.err_msg ?? ""}。${
      RET_TEXT[sessionRet] ?? "请重新登录后台并更新 .env 的 token 与 cookie。"
    }`
  );
}
console.log("✓ 登录态有效（searchbiz ret=0）");

// 2) 目标接口检查
if (!fakeid) {
  console.log("\n未传入 fakeid，跳过文章列表探测。用法：npm run probe:wechat -- MzI3MzYwODk2MQ==");
  process.exit(0);
}

const { json } = await get("/cgi-bin/appmsgpublish", {
  ajax: "1",
  begin: "0",
  count: "5",
  f: "json",
  fakeid,
  free_publish_type: "1",
  lang: "zh_CN",
  query: "",
  search_field: "null",
  sub: "list",
  sub_action: "list_ex",
  token,
  type: "101_1"
});
const ret = json?.base_resp?.ret;

if (ret !== 0) {
  fail(
    `appmsgpublish 返回 ret=${ret} ${json?.base_resp?.err_msg ?? ""}。${
      RET_TEXT[ret] ?? ""
    }\n  说明：登录态正常但文章列表接口被限流，说明该接口的独立配额已耗尽，与 cookie/token 无关。`
  );
}

const page = JSON.parse(json.publish_page ?? "{}");
const count = (page.publish_list ?? []).reduce((total, item) => {
  const info = JSON.parse(item.publish_info ?? "{}");
  return total + (info.appmsgex ?? []).length;
}, 0);

console.log(`✓ 文章列表接口正常，首页返回 ${count} 篇（total_count=${page.total_count ?? "?"}）`);
console.log("  可以开始批量导出。建议首次先用小 limit（如 5）验证。");
