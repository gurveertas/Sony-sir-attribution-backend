/*! Wink Attribution SDK v1 — https://<api>/sdk/v1.js
 * <script async src="https://API/sdk/v1.js" data-key="pk_live_..." data-consent="required"></script>
 * API: Wink.identify(email, phone) · Wink.getCheckoutToken() → Promise<token> · Wink.decorateLinks(opts)
 *      Wink.consent(true|false) · Wink.track() · queue calls before load: window.wink=window.wink||function(){(wink.q=wink.q||[]).push(arguments)}
 */
(function (w, d) {
  "use strict";
  if (w.Wink && w.Wink.v) return;
  var s = d.currentScript || d.querySelector("script[data-key][src*='sdk/v1']") || {};
  var ds = s.dataset || {};
  var KEY = ds.key || "", API = (ds.api || (s.src ? new URL(s.src).origin : "")).replace(/\/+$/, "");
  var CONSENT_REQ = ds.consent === "required", P = "_wk_";
  var CLICK = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"];
  var UTM = ["source", "medium", "campaign", "term", "content"];
  var AFF = { awc: "awin", irclickid: "impact", cjevent: "cj", ranmid: "rakuten", clickref: "partnerize" };
  var DOMAINS = ["zenoti.com", "fresha.com", "mindbodyonline.com", "vagaro.com", "calendly.com", "booksy.com", "setmore.com"];

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(P + k); if (v === null) localStorage.removeItem(P + k); else localStorage.setItem(P + k, v); } catch (e) {} return null; }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(P + k); sessionStorage.setItem(P + k, v); } catch (e) {} return null; }
  function ck(n, v, days) {
    if (v === undefined) { var m = d.cookie.match("(?:^|; )" + n.replace(/\./g, "\\.") + "=([^;]*)"); return m ? decodeURIComponent(m[1]) : null; }
    var host = location.hostname.split("."), dom = host.length > 2 ? "; domain=." + host.slice(-2).join(".") : "";
    d.cookie = n + "=" + encodeURIComponent(v) + "; max-age=" + days * 86400 + "; path=/; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "") + dom;
  }
  function uuid() { return (w.crypto && crypto.randomUUID) ? crypto.randomUUID() : "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
  function qp() { var o = {}; try { new URL(location.href).searchParams.forEach(function (v, k) { o[k.toLowerCase()] = v; }); } catch (e) {} return o; }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }

  var consent = ck(P + "c"); // "1" granted, "0" denied, null unknown
  function allowed() { return consent === "1" || (!CONSENT_REQ && consent !== "0"); }
  function cv() { return consent === "1" ? true : undefined; } // explicit consent only; the server enforces opt-in mode

  // first-party visitor id: cookie (Safari may cap it at 7 days) + localStorage + id passed in a decorated link
  var params = qp();
  var vid = params._wkv || ck(P + "vid") || ls("vid");
  function persistVid() { if (!vid) vid = uuid(); ck(P + "vid", vid, 730); ls("vid", vid); }

  // ── sending with queue + retry ──
  function queue() { try { return JSON.parse(ls("q") || "[]"); } catch (e) { return []; } }
  function save(q) { ls("q", JSON.stringify(q.slice(-50))); }
  function post(path, body) {
    return fetch(API + "/v1/" + path, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY }, body: JSON.stringify(body) })
      .then(function (r) { if (r.status >= 500 || r.status === 429) throw new Error("retry"); return r.json().catch(function () { return {}; }); });
  }
  var busy = false, delay = 2000;
  function flush() {
    if (busy || !allowed()) return;
    var q = queue(); if (!q.length) return;
    busy = true;
    var item = q[0];
    post(item.p, item.b).then(function () { save(queue().slice(1)); busy = false; delay = 2000; flush(); },
      function () { busy = false; item.n = (item.n || 0) + 1; var q2 = queue(); if (item.n > 8) q2.shift(); else q2[0] = item; save(q2); setTimeout(flush, delay = Math.min(delay * 2, 60000)); });
  }
  function send(path, body) { if (!allowed() || !KEY) return; var q = queue(); q.push({ p: path, b: body }); save(q); flush(); }

  // ── touches ──
  function touch(force) {
    if (!allowed()) return;
    persistVid();
    var p = qp(), t = { visitorId: vid, consent: cv(), touchedAt: new Date().toISOString(), landingPage: location.href, pageTitle: d.title, referrer: d.referrer || null };
    var campaign = false, i;
    for (i = 0; i < UTM.length; i++) if (p["utm_" + UTM[i]]) { t[UTM[i]] = p["utm_" + UTM[i]]; campaign = true; }
    for (i = 0; i < CLICK.length; i++) if (p[CLICK[i]]) { t[CLICK[i] === "gbraid" || CLICK[i] === "wbraid" ? "gclid" : CLICK[i]] = p[CLICK[i]]; campaign = true; }
    for (var a in AFF) if (p[a]) { campaign = true; if (!t.source) { t.source = AFF[a]; t.medium = "affiliate"; t.content = p[a]; } }
    t.fbc = ck("_fbc") || (p.fbclid ? "fb.1." + Date.now() + "." + p.fbclid : null); t.fbp = ck("_fbp"); t.ga = ck("_ga");
    var external = d.referrer && host(d.referrer) !== host(location.href);
    var newSession = !ss("s");
    ss("s", "1");
    if (force || campaign || external || newSession) send("touches", t);
  }

  // ── identify / checkout token ──
  function identify(email, phone) {
    if (typeof email === "object" && email) { phone = email.phone; email = email.email; }
    if (!email && !phone) return;
    persistVid(); send("identify", { visitorId: vid, email: email || undefined, phone: phone || undefined, consent: cv() });
  }
  var pending = null;
  function getCheckoutToken() {
    if (!allowed() || !KEY) return Promise.resolve(null);
    var c = ss("tok"); if (c) { try { c = JSON.parse(c); if (c.e > Date.now()) return Promise.resolve(c.t); } catch (e) {} }
    if (pending) return pending;
    persistVid(); flush();
    pending = post("checkout-sessions", { visitorId: vid, consent: cv() }).then(function (r) {
      pending = null; if (r && r.token) { ss("tok", JSON.stringify({ t: r.token, e: Date.now() + 1800000 })); writeToken(r.token); } return r && r.token || null;
    }, function () { pending = null; return null; });
    return pending;
  }

  // writes the token into known platforms: Shopify cart attributes, WooCommerce / any form, custom inputs
  function writeToken(tok) {
    if (w.Shopify && w.fetch) fetch("/cart/update.js", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attributes: { attribution_token: tok } }) }).catch(function () {});
    var forms = d.querySelectorAll("form.checkout, form.woocommerce-checkout, form.cart, form[data-wink-checkout]");
    for (var i = 0; i < forms.length; i++) {
      var f = forms[i], inp = f.querySelector("input[name=attribution_token]");
      if (!inp) { inp = d.createElement("input"); inp.type = "hidden"; inp.name = "attribution_token"; f.appendChild(inp); }
      inp.value = tok;
    }
    var custom = d.querySelectorAll("[data-wink-token]");
    for (var j = 0; j < custom.length; j++) { if ("value" in custom[j]) custom[j].value = tok; else custom[j].setAttribute("data-wink-token", tok); }
  }

  // adds the token (and visitor id) to outbound booking-widget links so the booking carries it
  function decorateLinks(opts) {
    opts = opts || {};
    var doms = (opts.domains || []).concat(DOMAINS), param = opts.param || "wtok";
    function match(a) { if (a.hasAttribute("data-wink-decorate")) return true; var h = host(a.href); for (var i = 0; i < doms.length; i++) if (h === doms[i] || h.slice(-doms[i].length - 1) === "." + doms[i]) return true; return false; }
    function apply(tok) {
      var links = d.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var a = links[i]; if (!match(a)) continue;
        try { var u = new URL(a.href); u.searchParams.set(param, tok); u.searchParams.set("_wkv", vid); a.href = u.toString(); } catch (e) {}
      }
      var frames = d.querySelectorAll("iframe[src]");
      for (var k = 0; k < frames.length; k++) { var f = frames[k]; if (!match({ href: f.src, hasAttribute: function (n) { return f.hasAttribute(n); } })) continue; try { var fu = new URL(f.src); if (fu.searchParams.get(param) !== tok) { fu.searchParams.set(param, tok); f.src = fu.toString(); } } catch (e) {} }
    }
    return getCheckoutToken().then(function (tok) { if (tok) apply(tok); return tok; });
  }

  function setConsent(granted) {
    consent = granted ? "1" : "0"; ck(P + "c", consent, 365);
    if (granted) { touch(true); flush(); } else { ls("q", null); }
  }

  var api = { v: "1.0.0", identify: identify, getCheckoutToken: getCheckoutToken, decorateLinks: decorateLinks, consent: setConsent, track: function () { touch(true); }, visitorId: function () { return vid; } };
  w.Wink = api;
  var early = (w.wink && w.wink.q) || [];
  w.wink = function (m) { var a = [].slice.call(arguments, 1); return api[m] && api[m].apply(null, a); };
  touch(false); flush();
  for (var e = 0; e < early.length; e++) w.wink.apply(null, early[e]);
  if (ds.autoDecorate !== "false") {
    var go = function () { if (d.querySelector("a[data-wink-decorate], a[href*='zenoti.com'], a[href*='fresha.com'], a[href*='vagaro.com'], a[href*='mindbodyonline.com']")) decorateLinks(); };
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", go); else go();
  }
  // checkout pages of known platforms get their token without extra code
  if (/\/(checkout|cart)/.test(location.pathname) || d.querySelector("form.checkout, form.woocommerce-checkout, form[data-wink-checkout]")) getCheckoutToken();
})(window, document);
