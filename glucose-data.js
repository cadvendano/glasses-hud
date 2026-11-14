/*
 * glucose-data.js  -  Glasses HUD data layer (Phase 3)
 *
 * The one place that knows how to talk to Nightscout and how to turn raw
 * entries into clean readings and stats. The dashboard (index.html) only
 * calls the functions below; the future glasses/hub app should copy this
 * same contract (port it to Kotlin), so the data source can be swapped
 * later (e.g. official Dexcom API) without touching any display code.
 *
 * Contract - a "reading" always looks like:
 *   { time: 1794626888000,      // epoch milliseconds (UTC instant)
 *     mgdl: 112,                // glucose, mg/dL
 *     direction: "Flat",        // Nightscout trend name
 *     arrow: "→",               // display arrow
 *     trend: "steady",          // plain-words trend
 *     device: "DX011G" }        // what produced it
 *
 * Security: the token is passed in by the caller and only ever sent to the
 * Nightscout server. Nothing here stores it.
 */
(function (global) {
  "use strict";

  var TIME_ZONE = "America/New_York";

  var TRENDS = {
    DoubleUp:        { arrow: "⇈", trend: "rising fast" },
    SingleUp:        { arrow: "↑", trend: "rising" },
    FortyFiveUp:     { arrow: "↗", trend: "rising slowly" },
    Flat:            { arrow: "→", trend: "steady" },
    FortyFiveDown:   { arrow: "↘", trend: "falling slowly" },
    SingleDown:      { arrow: "↓", trend: "falling" },
    DoubleDown:      { arrow: "⇊", trend: "falling fast" },
    "NOT COMPUTABLE":{ arrow: "–", trend: "no trend" },
    "RATE OUT OF RANGE": { arrow: "–", trend: "no trend" },
    NONE:            { arrow: "–", trend: "no trend" }
  };

  function AuthError(message) {
    this.name = "AuthError";
    this.message = message || "Token not accepted";
  }
  AuthError.prototype = Object.create(Error.prototype);

  /* ---------- 1. Fetch ---------- */

  function createNightscoutSource(opts) {
    var baseUrl = String(opts.baseUrl || "").replace(/\/+$/, "");
    var token = String(opts.token || "").trim();

    function get(path, params) {
      var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      });
      q.push("token=" + encodeURIComponent(token));
      return fetch(baseUrl + path + "?" + q.join("&"), { cache: "no-store" })
        .then(function (r) {
          if (r.status === 401 || r.status === 403) throw new AuthError();
          if (!r.ok) throw new Error("Nightscout answered " + r.status);
          return r.json();
        });
    }

    return {
      /** Newest reading, or null if none. */
      latest: function () {
        return get("/api/v1/entries/sgv.json", { count: 1 }).then(function (rows) {
          var list = normalize(rows);
          return list.length ? list[list.length - 1] : null;
        });
      },
      /** All readings at or after sinceMs, oldest first. */
      since: function (sinceMs, max) {
        return get("/api/v1/entries/sgv.json", {
          "find[date][$gte]": Math.floor(sinceMs),
          count: max || 3000
        }).then(normalize);
      }
    };
  }

  /* ---------- 2. Normalize ---------- */

  function normalize(rows) {
    var seen = {};
    var out = [];
    (rows || []).forEach(function (e) {
      var mgdl = Number(e.sgv);
      var time = Number(e.date);
      if (!isFinite(mgdl) || mgdl <= 0 || !isFinite(time)) return;
      if (seen[time]) return; // drop duplicate uploads
      seen[time] = true;
      var t = TRENDS[e.direction] || TRENDS.NONE;
      out.push({
        time: time,
        mgdl: Math.round(mgdl),
        direction: e.direction || "NONE",
        arrow: t.arrow,
        trend: t.trend,
        device: e.device || ""
      });
    });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  /* ---------- 3. Stats ---------- */

  function stats(readings, range) {
    var low = (range && range.low) || 70;
    var high = (range && range.high) || 180;
    var n = readings.length;
    if (!n) return { count: 0, avg: null, tirPct: null, belowPct: null, abovePct: null, min: null, max: null };
    var sum = 0, inR = 0, below = 0, above = 0, min = Infinity, max = -Infinity;
    readings.forEach(function (r) {
      sum += r.mgdl;
      if (r.mgdl < low) below++; else if (r.mgdl > high) above++; else inR++;
      if (r.mgdl < min) min = r.mgdl;
      if (r.mgdl > max) max = r.mgdl;
    });
    return {
      count: n,
      avg: Math.round(sum / n),
      tirPct: Math.round((inR / n) * 100),
      belowPct: Math.round((below / n) * 100),
      abovePct: Math.round((above / n) * 100),
      min: min,
      max: max
    };
  }

  /* ---------- Time helpers (Eastern) ---------- */

  function etParts(ms) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
      timeZoneName: "shortOffset"
    }).formatToParts(new Date(ms));
    var p = {};
    parts.forEach(function (x) { p[x.type] = x.value; });
    var m = /GMT([+-]\d+)(?::(\d+))?/.exec(p.timeZoneName || "GMT-5");
    var offMin = m ? Number(m[1]) * 60 + (m[1][0] === "-" ? -1 : 1) * Number(m[2] || 0) : -300;
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), offMin: offMin };
  }

  /** Epoch ms of midnight Eastern on the day containing ms. */
  function startOfDayET(ms) {
    var p = etParts(ms);
    var guess = Date.UTC(p.y, p.m - 1, p.d) - p.offMin * 60000;
    // Re-check offset at midnight itself (handles daylight-saving change days)
    var p2 = etParts(guess);
    return Date.UTC(p.y, p.m - 1, p.d) - p2.offMin * 60000;
  }

  /** [start, end) of the Eastern calendar day containing ms (23/25-hour DST days included). */
  function dayRangeET(ms) {
    var start = startOfDayET(ms);
    return { start: start, end: startOfDayET(start + 36 * 3600000) };
  }

  /** Readings with start <= time < end. */
  function between(readings, start, end) {
    return readings.filter(function (r) { return r.time >= start && r.time < end; });
  }

  function formatTimeET(ms) {
    return new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  }
  function formatDayET(ms) {
    return new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
  }

  /** One stats row per Eastern calendar day, newest first. */
  function dailySummaries(readings, range) {
    var groups = {};
    readings.forEach(function (r) {
      var key = startOfDayET(r.time);
      (groups[key] = groups[key] || []).push(r);
    });
    return Object.keys(groups).map(Number).sort(function (a, b) { return b - a; })
      .map(function (day) {
        var s = stats(groups[day], range);
        s.dayStart = day;
        s.label = formatDayET(day);
        return s;
      });
  }

  global.GlucoseData = {
    TIME_ZONE: TIME_ZONE,
    AuthError: AuthError,
    createNightscoutSource: createNightscoutSource,
    normalize: normalize,
    stats: stats,
    dailySummaries: dailySummaries,
    startOfDayET: startOfDayET,
    dayRangeET: dayRangeET,
    between: between,
    formatTimeET: formatTimeET,
    formatDayET: formatDayET
  };
})(typeof window !== "undefined" ? window : globalThis);
