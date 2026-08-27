(() => {
  "use strict";

  const payload = window.ROV_ACTIVITY_DATA;
  if (!payload || !Array.isArray(payload.activities)) {
    document.body.innerHTML = '<main class="empty-state"><h2>数据加载失败</h2><p>请先运行 scripts/build_data.py 生成活动数据。</p></main>';
    return;
  }

  const activities = payload.activities.map(normalizeActivityText);
  const meta = payload.meta;
  const recordUrlBase = meta.recordUrlBase || "https://moonton.feishu.cn/base/K9ffbRhAAam8o7sS92Pchpo5nTg?table=tblcTEBdqkE7Jwpa";
  const QUALITY_ORDER = { "SSS+": 0, SSS: 1, "SS+": 2, SS: 3, "S+": 4, S: 5, A: 6, B: 7, "/": 8 };
  const QUALITY_COLORS = { "SSS+": "#a9272c", SSS: "#c9444b", "SS+": "#d65b55", SS: "#e9943d", "S+": "#d6ae39", S: "#90b63f", A: "#55a56b", B: "#3c96e8" };
  const RESOURCE_COLORS = { 英雄: "#68c5c3", 点券: "#d5a64f", 常规资源: "#759b73", 抽奖代币: "#bc7ba7", 小资源: "#5b9ac5", 其他: "#7d888d" };
  const ACTIVITY_COLORS = { active: "#9bd7ad", paidFallback: "#e6a1a1", unknown: "#95a1a8" };
  const GRAIN = { day: 28, week: 10, month: 4 };
  const MIN_AXIS_DAYS = { day: 90, week: 240, month: 730 };
  const DISPLAY_SCALES = [0.9, 1, 1.1, 1.25];
  const DEFAULT_DISPLAY_SCALE = 1.1;
  const DISPLAY_SCALE_STORAGE_KEY = "rov-activity-gantt-display-scale";
  const state = {
    start: null,
    end: null,
    axisStart: null,
    axisEnd: null,
    grain: "week",
    windowDays: 30,
    perspective: "activity",
    mode: "active",
    query: "",
    type: "all",
    quality: "all",
    hotspot: "all",
    displayScale: DEFAULT_DISPLAY_SCALE,
    selected: null,
    drawerImages: [],
    activeImage: 0,
    lightboxIndex: 0,
    suppressBarClick: false,
    isDragging: false,
    shouldFocusWindow: true,
  };

  const el = (id) => document.getElementById(id);
  const dom = {
    generatedAt: el("generatedAt"), dataRange: el("dataRange"), search: el("searchInput"),
    start: el("startDate"), end: el("endDate"), type: el("typeFilter"), quality: el("qualityFilter"), hotspot: el("hotspotFilter"),
    hotspotOptions: el("hotspotOptions"), hotspotClear: el("hotspotClear"),
    reset: el("resetButton"), today: el("todayButton"),
    scaleDown: el("scaleDown"), scaleUp: el("scaleUp"), scaleValue: el("scaleValue"),
    visibleCount: el("visibleCount"), totalCount: el("totalCount"), skinCount: el("skinCount"),
    hotspotCount: el("hotspotCount"), peakCount: el("peakCount"), peakDate: el("peakDate"),
    visibleMetricLabel: el("visibleMetricLabel"), skinMetricLabel: el("skinMetricLabel"),
    hotspotMetricLabel: el("hotspotMetricLabel"), peakMetricLabel: el("peakMetricLabel"),
    windowLabel: el("windowLabel"), resultSummary: el("resultSummary"), viewport: el("ganttViewport"),
    previousWindow: el("previousWindow"), nextWindow: el("nextWindow"),
    stage: el("ganttStage"), header: el("ganttHeader"), body: el("ganttBody"), empty: el("emptyState"),
    drawer: el("detailDrawer"), drawerContent: el("drawerContent"), drawerClose: el("drawerClose"),
    backdrop: el("drawerBackdrop"), lightbox: el("lightbox"), lightboxImage: el("lightboxImage"),
    lightboxCaption: el("lightboxCaption"), lightboxClose: el("lightboxClose"),
    lightboxPrev: el("lightboxPrev"), lightboxNext: el("lightboxNext"),
  };

  function parseDate(value) { return value ? new Date(`${value}T00:00:00`) : null; }
  function isoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  function todayDate() { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
  function addDays(date, days) { const next = new Date(date); next.setDate(next.getDate() + days); return next; }
  function daysBetween(start, end) { return Math.round((end - start) / 86400000); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function formatDate(value) {
    const date = typeof value === "string" ? parseDate(value) : value;
    if (!date) return "待补充";
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
  }
  function formatShortDate(date) { return `${date.getMonth() + 1}/${date.getDate()}`; }
  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }
  function parseLinkedText(value = "") {
    const source = String(value || "");
    const pattern = /\[([^\]\r\n]+)\]\((https?:\/\/[^)\s]+)\)/gi;
    const links = [];
    let text = "";
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      text += source.slice(cursor, match.index);
      const start = text.length;
      text += match[1];
      links.push({ start, end: text.length, url: match[2] });
      cursor = match.index + match[0].length;
    }
    text += source.slice(cursor);
    return { text, links };
  }
  function safeExternalUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }
  function renderLinkedText(text, links = []) {
    if (!links.length) return escapeHtml(text);
    let html = "";
    let cursor = 0;
    links.forEach((link) => {
      const url = safeExternalUrl(link.url);
      if (!url || link.start < cursor || link.end > text.length) return;
      html += escapeHtml(text.slice(cursor, link.start));
      html += `<a class="inline-source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text.slice(link.start, link.end))}</a>`;
      cursor = link.end;
    });
    return html + escapeHtml(text.slice(cursor));
  }
  function normalizeActivityText(activity) {
    const name = parseLinkedText(activity.name);
    const hotspot = parseLinkedText(activity.hotspot);
    return {
      ...activity,
      name: name.text,
      nameLinks: name.links,
      hotspot: hotspot.text || null,
      hotspotLinks: hotspot.links,
      resources: activity.resources.map((resource) => {
        const resourceName = parseLinkedText(resource.name);
        return { ...resource, name: resourceName.text, nameLinks: resourceName.links };
      }),
    };
  }
  function qualityClass(value) { return { B: "q-b", A: "q-a", S: "q-s", "S+": "q-splus", SS: "q-ss", "SS+": "q-ssplus", SSS: "q-sss", "SSS+": "q-sssplus" }[value] || "q-a"; }
  function qualityBadge(value, extra = "") {
    if (!value || value === "/") return "";
    return `<i class="quality-badge ${qualityClass(value)} ${extra}">${escapeHtml(value)}</i>`;
  }
  function highestQuality(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => (QUALITY_ORDER[a] ?? 99) - (QUALITY_ORDER[b] ?? 99))[0] || null;
  }
  function activityEnd(activity) { return parseDate(activity.end || activity.start); }
  function overlaps(activity, start, end) {
    const activityStart = parseDate(activity.start);
    const activityFinish = activityEnd(activity);
    return activityStart && activityFinish && activityStart <= end && activityFinish >= start;
  }

  function hotspotTerms(value) {
    return String(value || "").split(/[、，,]/).map((term) => term.trim()).filter(Boolean);
  }

  function buildHotspotGroups() {
    const activitiesByName = new Map();
    activities.forEach((activity) => {
      hotspotTerms(activity.hotspot).forEach((name) => {
        if (!activitiesByName.has(name)) activitiesByName.set(name, []);
        activitiesByName.get(name).push(activity);
      });
    });
    return [...activitiesByName.entries()]
      .flatMap(([name, themedActivities]) => {
        const sorted = themedActivities
          .filter((activity) => activity.start)
          .sort((left, right) => parseDate(left.start) - parseDate(right.start) || activityEnd(left) - activityEnd(right));
        const segments = [];
        sorted.forEach((activity) => {
          const start = parseDate(activity.start);
          const end = activityEnd(activity);
          const current = segments[segments.length - 1];
          if (!current || start > addDays(parseDate(current.end), 1)) {
            segments.push({ name, start: activity.start, end: isoDate(end), activities: [activity] });
          } else {
            current.activities.push(activity);
            if (end > parseDate(current.end)) current.end = isoDate(end);
          }
        });
        return segments.map((group, index) => ({
          ...group,
          id: `${name}::${group.start}::${index + 1}`,
          segmentIndex: index + 1,
          segmentTotal: segments.length,
          skinQualities: [...new Set(group.activities.flatMap((activity) => activity.skinQualities))],
          highestSkinQuality: highestQuality(group.activities.map((activity) => activity.highestSkinQuality)),
        }));
      })
      .sort((left, right) => parseDate(left.start) - parseDate(right.start) || left.name.localeCompare(right.name, "zh-CN"));
  }

  const hotspotGroups = buildHotspotGroups();
  const hotspotCatalog = [...new Set(hotspotGroups.map((group) => group.name))]
    .map((name) => ({
      name,
      activities: [...new Map(hotspotGroups.filter((group) => group.name === name).flatMap((group) => group.activities).map((activity) => [activity.id, activity])).values()],
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));

  function hotspotOptionText(group) {
    return `${group.name}——${group.activities.length}个活动`;
  }

  function selectedHotspotGroup(value) {
    const normalized = String(value || "").trim();
    return hotspotCatalog.find((group) => normalized === group.name || normalized === hotspotOptionText(group)) || null;
  }

  let visibleHotspotOptions = [];
  let activeHotspotOptionIndex = -1;

  function hotspotChoices(query = "") {
    const normalized = String(query || "").trim().toLocaleLowerCase("zh-CN");
    const choices = hotspotCatalog
      .map((group) => ({ value: hotspotOptionText(group), group }))
      .filter((choice) => !normalized || choice.value.toLocaleLowerCase("zh-CN").includes(normalized));
    if (!normalized || "无关联热点".includes(normalized)) choices.unshift({ value: "无关联热点", group: null });
    return choices;
  }

  function renderHotspotOptions(query = "", open = true) {
    visibleHotspotOptions = hotspotChoices(query);
    activeHotspotOptionIndex = -1;
    dom.hotspot.removeAttribute("aria-activedescendant");
    dom.hotspotOptions.innerHTML = visibleHotspotOptions
      .map((choice, index) => `<button type="button" class="hotspot-option" id="hotspot-option-${index}" role="option" aria-selected="false" data-option-index="${index}" data-option-value="${escapeHtml(choice.value)}" title="${escapeHtml(choice.value)}">${escapeHtml(choice.value)}</button>`)
      .join("");
    dom.hotspotOptions.hidden = !open || !visibleHotspotOptions.length;
    dom.hotspot.setAttribute("aria-expanded", String(open && visibleHotspotOptions.length > 0));
  }

  function closeHotspotOptions() {
    dom.hotspotOptions.hidden = true;
    dom.hotspot.setAttribute("aria-expanded", "false");
    dom.hotspot.removeAttribute("aria-activedescendant");
    activeHotspotOptionIndex = -1;
  }

  function activateHotspotOption(index) {
    if (!visibleHotspotOptions.length) return;
    activeHotspotOptionIndex = (index + visibleHotspotOptions.length) % visibleHotspotOptions.length;
    const options = [...dom.hotspotOptions.querySelectorAll(".hotspot-option")];
    options.forEach((option, optionIndex) => {
      const selected = optionIndex === activeHotspotOptionIndex;
      option.classList.toggle("is-active", selected);
      option.setAttribute("aria-selected", String(selected));
    });
    const active = options[activeHotspotOptionIndex];
    if (active) {
      dom.hotspot.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function populateHotspotFilter() {
    renderHotspotOptions("", false);
  }

  function normalizedHotspotFilter(value) {
    const normalized = String(value || "").trim();
    if (!normalized || normalized === "全部热点") return "all";
    if (normalized === "无关联热点") return "none";
    return selectedHotspotGroup(normalized)?.name || normalized;
  }

  function focusHotspotWindow(group) {
    const datedActivities = group.activities.filter((activity) => activity.start);
    if (!datedActivities.length) return false;
    const earliest = new Date(Math.min(...datedActivities.map((activity) => parseDate(activity.start).getTime())));
    const latest = new Date(Math.max(...datedActivities.map((activity) => activityEnd(activity).getTime())));
    state.start = addDays(earliest, -7);
    state.end = addDays(latest, 7);
    state.windowDays = daysBetween(state.start, state.end) + 1;
    dom.start.value = isoDate(state.start);
    dom.end.value = isoDate(state.end);
    document.querySelectorAll("[data-window]").forEach((button) => button.classList.remove("is-active"));
    return true;
  }

  function matchesHotspotFilter(value, filter = state.hotspot) {
    if (filter === "all") return true;
    if (filter === "none") return hotspotTerms(value).length === 0;
    const query = filter.toLocaleLowerCase("zh-CN");
    return hotspotTerms(value).some((term) => term.toLocaleLowerCase("zh-CN").includes(query));
  }

  function storedDisplayScale() {
    try {
      const value = Number(localStorage.getItem(DISPLAY_SCALE_STORAGE_KEY));
      return DISPLAY_SCALES.includes(value) ? value : DEFAULT_DISPLAY_SCALE;
    } catch (_error) {
      return DEFAULT_DISPLAY_SCALE;
    }
  }

  function applyDisplayScale(scale, persist = true) {
    const normalized = DISPLAY_SCALES.includes(scale) ? scale : DEFAULT_DISPLAY_SCALE;
    state.displayScale = normalized;
    document.documentElement.style.setProperty("--display-scale", String(normalized));
    document.documentElement.style.setProperty("--unscaled-viewport-width", `${100 / normalized}vw`);
    document.documentElement.style.setProperty("--app-max-width", `${1880 / normalized}px`);
    dom.scaleValue.value = `${Math.round(normalized * 100)}%`;
    dom.scaleValue.textContent = `${Math.round(normalized * 100)}%`;
    dom.scaleDown.disabled = normalized === DISPLAY_SCALES[0];
    dom.scaleUp.disabled = normalized === DISPLAY_SCALES[DISPLAY_SCALES.length - 1];
    if (persist) {
      try { localStorage.setItem(DISPLAY_SCALE_STORAGE_KEY, String(normalized)); } catch (_error) { /* 本地存储不可用时仍保留当前会话缩放 */ }
    }
    if (state.start && state.end) {
      state.shouldFocusWindow = true;
      render();
    }
  }

  function stepDisplayScale(direction) {
    const currentIndex = Math.max(0, DISPLAY_SCALES.indexOf(state.displayScale));
    applyDisplayScale(DISPLAY_SCALES[clamp(currentIndex + direction, 0, DISPLAY_SCALES.length - 1)]);
  }

  function setWindow(windowValue) {
    const anchor = todayDate();
    state.windowDays = windowValue;
    state.end = anchor;
    if (windowValue === "3y") {
      state.start = new Date(anchor.getFullYear() - 3, anchor.getMonth(), anchor.getDate());
      state.start = addDays(state.start, 1);
    } else {
      const days = Number(windowValue);
      state.start = addDays(anchor, -(days - 1));
    }
    dom.start.value = isoDate(state.start);
    dom.end.value = isoDate(state.end);
    document.querySelectorAll("[data-window]").forEach((button) => button.classList.toggle("is-active", button.dataset.window === String(windowValue)));
    state.shouldFocusWindow = true;
    render();
  }

  function panTimeline(direction) {
    const distance = Math.max(360, (dom.viewport.clientWidth - 308) * 0.72);
    dom.viewport.scrollBy({ left: distance * direction, behavior: "smooth" });
  }

  function timelineDomain(items) {
    let start = new Date(state.start);
    let end = new Date(state.end);
    items.forEach((activity) => {
      const activityStart = parseDate(activity.start);
      const activityFinish = activityEnd(activity);
      if (activityStart && activityStart < start) start = activityStart;
      if (activityFinish && activityFinish > end) end = activityFinish;
    });
    const currentDays = daysBetween(start, end) + 1;
    const extraDays = Math.max(0, MIN_AXIS_DAYS[state.grain] - currentDays);
    start = addDays(start, -Math.floor(extraDays / 2));
    end = addDays(end, Math.ceil(extraDays / 2));
    return { start, end };
  }

  function filteredActivities() {
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    return activities.filter((activity) => {
      const startsInWindow = parseDate(activity.start) >= state.start && parseDate(activity.start) <= state.end;
      if (state.mode === "launched" ? !startsInWindow : !overlaps(activity, state.start, state.end)) return false;
      if (state.type === "unknown" ? Boolean(activity.type) : state.type !== "all" && activity.type !== state.type) return false;
      if (state.quality === "skin" && !activity.highestSkinQuality) return false;
      if (state.quality === "none" && activity.highestSkinQuality) return false;
      if (!["all", "skin", "none"].includes(state.quality) && !activity.skinQualities.includes(state.quality)) return false;
      if (!matchesHotspotFilter(activity.hotspot)) return false;
      if (query) {
        const resourceText = activity.resources.map((resource) => `${resource.name} ${resource.type} ${resource.threshold}`).join(" ");
        const haystack = `${activity.name} ${activity.hotspot || ""} ${activity.behavior} ${resourceText}`.toLocaleLowerCase("zh-CN");
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  function filteredHotspots() {
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    if (state.hotspot === "none") return [];
    return hotspotGroups.filter((group) => {
      const startsInWindow = parseDate(group.start) >= state.start && parseDate(group.start) <= state.end;
      if (state.mode === "launched" ? !startsInWindow : !overlaps(group, state.start, state.end)) return false;
      if (state.hotspot !== "all" && !group.name.toLocaleLowerCase("zh-CN").includes(state.hotspot.toLocaleLowerCase("zh-CN"))) return false;
      const facetActivities = group.activities.filter((activity) => {
        if (state.type === "unknown" ? Boolean(activity.type) : state.type !== "all" && activity.type !== state.type) return false;
        if (state.quality === "skin" && !activity.highestSkinQuality) return false;
        if (state.quality === "none" && activity.highestSkinQuality) return false;
        if (!["all", "skin", "none"].includes(state.quality) && !activity.skinQualities.includes(state.quality)) return false;
        return true;
      });
      if (!facetActivities.length) return false;
      if (query) {
        const activityText = group.activities.map((activity) => {
          const resourceText = activity.resources.map((resource) => `${resource.name} ${resource.type} ${resource.threshold}`).join(" ");
          return `${activity.name} ${activity.behavior} ${resourceText}`;
        }).join(" ");
        if (!`${group.name} ${activityText}`.toLocaleLowerCase("zh-CN").includes(query)) return false;
      }
      return true;
    });
  }

  function renderHeader(totalDays, timelineWidth, dayWidth) {
    const today = todayDate();
    const timelineStart = state.axisStart;
    const timelineEnd = state.axisEnd;
    let primaryTicks = "";
    let secondaryTicks = "";

    if (state.grain === "month") {
      let cursor = new Date(timelineStart.getFullYear(), 0, 1);
      while (cursor <= timelineEnd) {
        const visibleStart = cursor < timelineStart ? timelineStart : cursor;
        const yearEnd = new Date(cursor.getFullYear(), 11, 31);
        const visibleEnd = yearEnd > timelineEnd ? timelineEnd : yearEnd;
        const left = daysBetween(timelineStart, visibleStart) * dayWidth;
        const width = (daysBetween(visibleStart, visibleEnd) + 1) * dayWidth;
        primaryTicks += `<div class="month-tick" style="left:${left}px;width:${width}px">${cursor.getFullYear()}</div>`;
        cursor = new Date(cursor.getFullYear() + 1, 0, 1);
      }
      cursor = new Date(timelineStart.getFullYear(), timelineStart.getMonth(), 1);
      while (cursor <= timelineEnd) {
        const visibleStart = cursor < timelineStart ? timelineStart : cursor;
        const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
        const visibleEnd = monthEnd > timelineEnd ? timelineEnd : monthEnd;
        const left = daysBetween(timelineStart, visibleStart) * dayWidth;
        const width = (daysBetween(visibleStart, visibleEnd) + 1) * dayWidth;
        secondaryTicks += `<div class="week-tick" style="left:${left}px;width:${width}px">${cursor.getMonth() + 1}月</div>`;
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }
    } else {
      let cursor = new Date(timelineStart.getFullYear(), timelineStart.getMonth(), 1);
      while (cursor <= timelineEnd) {
        const visibleStart = cursor < timelineStart ? timelineStart : cursor;
        const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
        const visibleEnd = monthEnd > timelineEnd ? timelineEnd : monthEnd;
        const left = daysBetween(timelineStart, visibleStart) * dayWidth;
        const width = (daysBetween(visibleStart, visibleEnd) + 1) * dayWidth;
        primaryTicks += `<div class="month-tick" style="left:${left}px;width:${width}px">${cursor.getFullYear()} · ${String(cursor.getMonth() + 1).padStart(2, "0")}</div>`;
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }
      if (state.grain === "day") {
        cursor = new Date(timelineStart);
        while (cursor <= timelineEnd) {
          const left = daysBetween(timelineStart, cursor) * dayWidth;
          const weekend = cursor.getDay() === 0 || cursor.getDay() === 6 ? " is-weekend" : "";
          secondaryTicks += `<div class="week-tick day-tick${weekend}" style="left:${left}px;width:${dayWidth}px">${cursor.getDate()}</div>`;
          cursor = addDays(cursor, 1);
        }
      } else {
        cursor = new Date(timelineStart);
        while (cursor.getDay() !== 1) cursor = addDays(cursor, 1);
        while (cursor <= timelineEnd) {
          const left = daysBetween(timelineStart, cursor) * dayWidth;
          secondaryTicks += `<div class="week-tick" style="left:${left}px;width:${dayWidth * 7}px">${formatShortDate(cursor)}</div>`;
          cursor = addDays(cursor, 7);
        }
      }
    }
    const todayOffset = daysBetween(timelineStart, today);
    const todayLine = today >= timelineStart && today <= timelineEnd ? `<div class="today-line" style="left:${todayOffset * dayWidth}px"></div>` : "";
    const filterLeft = daysBetween(timelineStart, state.start) * dayWidth;
    const filterWidth = (daysBetween(state.start, state.end) + 1) * dayWidth;
    dom.header.innerHTML = `
      <div class="header-label"><strong>${state.perspective === "hotspot" ? "热点主题" : "活动"}</strong><span>起止日期</span></div>
      <div class="timeline-head grain-${state.grain}" style="width:${timelineWidth}px"><div class="filter-window-band" style="left:${filterLeft}px;width:${filterWidth}px"><span>筛选窗口</span></div>${primaryTicks}${secondaryTicks}${todayLine}</div>`;
  }

  function rowAccent(activity) {
    if (activity.type === "活跃") return ACTIVITY_COLORS.active;
    if (activity.type === "付费") return activity.resources.length ? resourceAccent(activity.resources[0]) : ACTIVITY_COLORS.paidFallback;
    return ACTIVITY_COLORS.unknown;
  }

  function rowFrame(item, timelineWidth, dayWidth) {
    const today = todayDate();
    const timelineStart = state.axisStart;
    const timelineEnd = state.axisEnd;
    const todayInWindow = today >= timelineStart && today <= timelineEnd;
    const todayLeft = daysBetween(timelineStart, today) * dayWidth;
    const filterLeft = daysBetween(timelineStart, state.start) * dayWidth;
    const filterWidth = (daysBetween(state.start, state.end) + 1) * dayWidth;
    const start = parseDate(item.start);
    let end = activityEnd(item);
    if (end < start) end = start;
    const clippedStart = start < timelineStart ? timelineStart : start;
    const clippedEnd = end > timelineEnd ? timelineEnd : end;
    return {
      start, end,
      left: Math.max(0, daysBetween(timelineStart, clippedStart) * dayWidth),
      width: Math.max(20, (daysBetween(clippedStart, clippedEnd) + 1) * dayWidth - 3),
      clippedClasses: `${start < timelineStart ? " is-clipped-left" : ""}${end > timelineEnd ? " is-clipped-right" : ""}`,
      backdrop: `<div class="row-filter-window" style="left:${filterLeft}px;width:${filterWidth}px"></div>${todayInWindow ? `<div class="row-today-line" style="left:${todayLeft}px"></div>` : ""}`,
    };
  }

  function renderActivityRows(items, timelineWidth, dayWidth) {
    dom.body.innerHTML = items.map((activity, index) => {
      const frame = rowFrame(activity, timelineWidth, dayWidth);
      const { start, end, left, width, clippedClasses } = frame;
      const duration = daysBetween(start, end) + 1;
      const accent = rowAccent(activity);
      const quality = activity.highestSkinQuality;
      const isFree = activity.type === "活跃";
      return `
        <div class="gantt-row" style="--row-accent:${accent};animation-delay:${Math.min(index, 20) * 12}ms">
          <div class="activity-label">
            <div class="name"><strong title="${escapeHtml(activity.name)}">${escapeHtml(activity.name)}</strong><small>${formatDate(start)} — ${activity.end ? formatDate(end) : "结束待补"}</small></div>
          </div>
          <div class="timeline-cell" style="width:${timelineWidth}px">
            ${frame.backdrop}
            <button type="button" class="gantt-bar${quality ? " has-quality" : ""}${isFree ? " is-free" : ""}${clippedClasses}" data-activity-id="${activity.id}" data-activity-type="${escapeHtml(activity.type || "待判断")}" style="left:${left}px;width:${width}px;--bar-accent:${accent}" aria-label="查看 ${escapeHtml(activity.name)} 详情">
              ${isFree ? '<span class="free-tag">Free</span>' : ""}
              <span class="bar-content">${qualityBadge(quality)}<span class="bar-title">${escapeHtml(activity.name)}</span><span class="bar-duration">持续 ${duration} 天</span></span>
            </button>
          </div>
        </div>`;
    }).join("");
  }

  function renderHotspotRows(items, timelineWidth, dayWidth) {
    dom.body.innerHTML = items.map((group, index) => {
      const frame = rowFrame(group, timelineWidth, dayWidth);
      const active = group.activities.filter((activity) => activity.type === "活跃").length;
      const paid = group.activities.filter((activity) => activity.type === "付费").length;
      const unknown = group.activities.length - active - paid;
      const total = Math.max(1, group.activities.length);
      const freeEnd = active / total * 100;
      const paidEnd = (active + paid) / total * 100;
      return `
        <div class="gantt-row hotspot-row" style="--row-accent:#73a9a8;animation-delay:${Math.min(index, 20) * 12}ms">
          <div class="activity-label hotspot-label">
            <div class="name"><strong title="${escapeHtml(group.name)}">${escapeHtml(group.name)}${group.segmentTotal > 1 ? ` <em class="period-index">档期 ${group.segmentIndex}/${group.segmentTotal}</em>` : ""}</strong><small>${formatDate(frame.start)} — ${formatDate(frame.end)} · ${group.activities.length} 个活动</small></div>
          </div>
          <div class="timeline-cell" style="width:${timelineWidth}px">
            ${frame.backdrop}
            <button type="button" class="gantt-bar hotspot-bar${frame.clippedClasses}" data-hotspot-id="${escapeHtml(group.id)}" data-hotspot-name="${escapeHtml(group.name)}" style="left:${frame.left}px;width:${frame.width}px;--free-end:${freeEnd}%;--paid-end:${paidEnd}%" aria-label="查看热点 ${escapeHtml(group.name)} 详情">
              <span class="bar-content">${qualityBadge(group.highestSkinQuality)}<span class="bar-title">${escapeHtml(group.name)}</span><span class="bar-duration">共 ${group.activities.length} 个活动</span></span>
              <span class="hotspot-mix" aria-hidden="true"><i class="mix-free">${active}</i><i class="mix-paid">${paid}</i>${unknown ? `<i class="mix-unknown">${unknown}</i>` : ""}</span>
            </button>
          </div>
        </div>`;
    }).join("");
  }

  function renderRows(items, timelineWidth, dayWidth) {
    if (state.perspective === "hotspot") renderHotspotRows(items, timelineWidth, dayWidth);
    else renderActivityRows(items, timelineWidth, dayWidth);
  }

  function computePeak(items) {
    const counts = new Map();
    items.forEach((activity) => {
      let cursor = parseDate(activity.start) < state.start ? new Date(state.start) : parseDate(activity.start);
      const end = activityEnd(activity) > state.end ? state.end : activityEnd(activity);
      while (cursor <= end) {
        const key = isoDate(cursor);
        counts.set(key, (counts.get(key) || 0) + 1);
        cursor = addDays(cursor, 1);
      }
    });
    let peak = { count: 0, date: null };
    counts.forEach((count, date) => { if (count > peak.count) peak = { count, date }; });
    return peak;
  }

  function renderMetrics(items) {
    const peak = computePeak(items);
    dom.visibleCount.textContent = items.length;
    const hotspotView = state.perspective === "hotspot";
    dom.visibleMetricLabel.textContent = hotspotView ? "窗口内热点档期" : "窗口内活动";
    dom.skinMetricLabel.textContent = hotspotView ? "含皮肤热点" : "皮肤资源活动";
    dom.hotspotMetricLabel.textContent = hotspotView ? "涵盖活动" : "关联热点";
    dom.peakMetricLabel.textContent = hotspotView ? "峰值热点档期" : "峰值并行";
    dom.totalCount.textContent = `全库 ${hotspotView ? hotspotGroups.length : meta.activityCount}`;
    dom.skinCount.textContent = items.filter((item) => item.highestSkinQuality).length;
    dom.hotspotCount.textContent = hotspotView
      ? new Set(items.flatMap((item) => item.activities.map((activity) => activity.id))).size
      : items.filter((item) => item.hotspot).length;
    dom.peakCount.textContent = peak.count;
    dom.peakDate.textContent = peak.date ? `${formatDate(peak.date)} 达峰` : "—";
  }

  function focusFilterWindow(behavior = "auto") {
    if (!state.axisStart || !state.start || !state.end) return;
    const dayWidth = GRAIN[state.grain];
    const filterStartLeft = daysBetween(state.axisStart, state.start) * dayWidth;
    const filterWidth = (daysBetween(state.start, state.end) + 1) * dayWidth;
    const target = 308 + filterStartLeft + filterWidth / 2 - dom.viewport.clientWidth / 2;
    dom.viewport.scrollTo({ left: Math.max(0, target), behavior });
  }

  function render() {
    if (!state.start || !state.end || state.end < state.start) return;
    const items = state.perspective === "hotspot" ? filteredHotspots() : filteredActivities();
    const filterDays = daysBetween(state.start, state.end) + 1;
    const domain = timelineDomain(items);
    state.axisStart = domain.start;
    state.axisEnd = domain.end;
    const totalDays = daysBetween(state.axisStart, state.axisEnd) + 1;
    const dayWidth = GRAIN[state.grain];
    const timelineWidth = totalDays * dayWidth;
    const minorGrid = state.grain === "day" ? dayWidth : state.grain === "week" ? dayWidth * 7 : dayWidth * 30.44;
    const majorGrid = state.grain === "day" ? dayWidth * 7 : state.grain === "week" ? dayWidth * 28 : dayWidth * 91.31;
    document.documentElement.style.setProperty("--timeline-width", `${timelineWidth}px`);
    document.documentElement.style.setProperty("--day-width", `${dayWidth}px`);
    document.documentElement.style.setProperty("--minor-grid", `${minorGrid}px`);
    document.documentElement.style.setProperty("--major-grid", `${majorGrid}px`);
    renderHeader(totalDays, timelineWidth, dayWidth);
    renderRows(items, timelineWidth, dayWidth);
    renderMetrics(items);
    dom.windowLabel.textContent = `${formatDate(state.start)} — ${formatDate(state.end)}`;
    dom.resultSummary.textContent = `${items.length} ${state.perspective === "hotspot" ? "个热点档期" : "条活动"} · ${filterDays} 天 · ${state.mode === "launched" ? "周期内上线" : "周期内有效"}`;
    dom.empty.hidden = items.length > 0;
    dom.viewport.hidden = items.length === 0;
    if (items.length && state.shouldFocusWindow) {
      state.shouldFocusWindow = false;
      requestAnimationFrame(() => { if (!state.isDragging) focusFilterWindow(); });
    }
  }

  function resourceAccent(resource) {
    if (resource.type === "皮肤" && resource.quality !== "/") return QUALITY_COLORS[resource.quality] || "#8e989f";
    return RESOURCE_COLORS[resource.type] || RESOURCE_COLORS.其他;
  }

  function compactResourceExpectation(threshold) {
    const text = String(threshold || "").replace(/\r/g, "");
    const segments = text.split(/[\n。；]/).map((part) => part.trim()).filter(Boolean);
    const number = "(?:\\d[\\d,.]*|[一二三四五六七八九十百]+)";
    const scoreSegment = (segment) => {
      let score = 0;
      if (/最终|修正|纳入|记录为/.test(segment)) score += 100;
      if (/期望|预期|预计/.test(segment)) score += 60;
      if (/约需|最快|最早|可达|可获得|拿到|拿满|满档/.test(segment)) score += 30;
      return score;
    };
    const pick = (patterns) => {
      let best = null;
      segments.forEach((segment, index) => {
        for (const pattern of patterns) {
          const match = segment.match(pattern);
          if (!match) continue;
          const candidate = { value: match[1].replace(/,/g, ""), score: scoreSegment(segment), index };
          if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.index > best.index)) best = candidate;
          break;
        }
      });
      return best?.value || null;
    };
    const points = pick([
      new RegExp(`(?:期望|预期|预计)(?:消耗|成本|花费|约需|需要)?[^。；\\n]{0,24}?(${number})\\s*点券`, "i"),
      new RegExp(`(?:获取成本|固定成本|保底成本|总成本|理论点券期望|点券期望|全付费保底|累计消耗|需消耗|需要消耗|约需)[^。；\\n]{0,20}?(${number})\\s*点券`, "i"),
      new RegExp(`(?:约|约合)\\s*(${number})\\s*点券`, "i"),
      new RegExp(`(${number})\\s*点券[^。；\\n]{0,12}(?:保底|可达|可获得|拿到|拿满)`, "i"),
    ]);
    const days = pick([
      new RegExp(`(?:期望|预期|预计|约需|最快|最早|记录为约|需要|需)[^。；\\n]{0,18}?(${number})\\s*天`, "i"),
      new RegExp(`(?:记录为)?约\\s*(${number})\\s*天`, "i"),
      new RegExp(`(?:第)?(${number})\\s*天[^。；\\n]{0,12}(?:可达|可获得|拿到|拿满|满档|领取|兑换)`, "i"),
      new RegExp(`(${number})\\s*天[^。；\\n]{0,12}(?:内可达|内获得|左右可达)`, "i"),
    ]);
    return [points ? `期望消耗 ${points} 点券` : "", days ? `期望 ${days} 天` : ""].filter(Boolean).join(" · ");
  }

  function renderResourceCards(resources, expanded = false) {
    const visible = expanded ? resources : resources.slice(0, 8);
    return `
      <div class="resource-list">
        ${visible.map((resource) => `
          <article class="resource-card" style="--resource-accent:${resourceAccent(resource)}">
            <span class="resource-icon">${escapeHtml(resource.type.slice(0, 1))}</span>
            <div class="resource-main">
              <p class="resource-title">${renderLinkedText(resource.name, resource.nameLinks)}${resource.quantity != null ? ` × ${resource.quantity}` : ""}</p>
              <div class="resource-meta">${escapeHtml(resource.type)}${resource.subtype && resource.subtype !== "/" ? ` · ${escapeHtml(resource.subtype)}` : ""}${resource.newness !== "/" ? ` · ${escapeHtml(resource.newness)}` : ""}</div>
            </div>
            <div class="resource-quality">${qualityBadge(resource.quality)}</div>
            <p class="resource-threshold">${escapeHtml(resource.threshold)}</p>
          </article>`).join("")}
      </div>
      ${!expanded && resources.length > 8 ? `<button type="button" class="more-resources" id="showAllResources">展开其余 ${resources.length - 8} 条资源</button>` : ""}`;
  }

  function renderScreenshotGallery(activity) {
    if (!activity.screenshots.length) return '<div class="screenshot-empty">该活动未上传截图</div>';
    state.drawerImages = activity.screenshots;
    state.activeImage = 0;
    const first = activity.screenshots[0];
    return `
      <div class="screenshot-main" id="screenshotMain" role="button" tabindex="0" aria-label="放大查看截图">
        <img id="screenshotMainImage" src="${escapeHtml(first.src)}" alt="${escapeHtml(first.name)}" loading="eager" />
      </div>
      ${activity.screenshots.length > 1 ? `<div class="screenshot-thumbs">${activity.screenshots.map((image, index) => `<button type="button" class="screenshot-thumb${index === 0 ? " is-active" : ""}" data-image-index="${index}" title="${escapeHtml(image.name)}"><img src="${escapeHtml(image.src)}" alt="" loading="lazy" /></button>`).join("")}</div>` : ""}`;
  }

  function distributionCounts(entries) {
    const counts = { active: 0, paid: 0, unknown: 0 };
    entries.forEach(({ activity }) => {
      if (activity.type === "活跃") counts.active += 1;
      else if (activity.type === "付费") counts.paid += 1;
      else counts.unknown += 1;
    });
    return counts;
  }

  function renderDistribution(entries, unit = "项") {
    const counts = distributionCounts(entries);
    const total = Math.max(1, entries.length);
    return `
      <div class="distribution-block" aria-label="付费免费分布">
        <div class="distribution-track">
          <i class="distribution-free" style="width:${counts.active / total * 100}%"></i>
          <i class="distribution-paid" style="width:${counts.paid / total * 100}%"></i>
          <i class="distribution-unknown" style="width:${counts.unknown / total * 100}%"></i>
        </div>
        <div class="distribution-legend"><span><i class="dot-free"></i>免费 ${counts.active} ${unit}</span><span><i class="dot-paid"></i>付费 ${counts.paid} ${unit}</span>${counts.unknown ? `<span><i class="dot-unknown"></i>待判断 ${counts.unknown} ${unit}</span>` : ""}</div>
      </div>`;
  }

  function hotspotResourceEntries(group, skinOnly) {
    return group.activities.flatMap((activity) => activity.resources
      .filter((resource) => skinOnly ? resource.type === "皮肤" : resource.type !== "皮肤")
      .map((resource) => ({ resource, activity })));
  }

  function renderHotspotResourceCard({ resource, activity }) {
    const expectation = compactResourceExpectation(resource.threshold);
    const access = activity.type === "活跃" ? { key: "free", label: "免费" } : activity.type === "付费" ? { key: "paid", label: "付费" } : { key: "unknown", label: "待判断" };
    return `
      <article class="hotspot-resource-card access-${access.key}" style="--resource-accent:${resourceAccent(resource)}">
        <div class="hotspot-resource-head"><strong>${renderLinkedText(resource.name, resource.nameLinks)}</strong><span class="hotspot-resource-flags">${qualityBadge(resource.quality)}<i class="resource-access-tag">${access.label}</i></span></div>
        <span class="hotspot-resource-meta">${escapeHtml(resource.type)}</span>
        <small title="${escapeHtml(activity.name)}">来自 ${escapeHtml(activity.name)}</small>
        ${expectation ? `<p class="hotspot-resource-expectation">${escapeHtml(expectation)}</p>` : ""}
      </article>`;
  }

  function renderHotspotResources(title, entries, emptyText) {
    const preview = entries.slice(0, 8);
    const remaining = entries.slice(8);
    return `
      <section class="drawer-section hotspot-resource-section">
        <div class="section-heading"><h3>${title}</h3><span>${entries.length} 项</span></div>
        ${entries.length ? `${renderDistribution(entries)}<div class="hotspot-resource-grid">${preview.map(renderHotspotResourceCard).join("")}</div>${remaining.length ? `<details class="hotspot-resource-more"><summary>展开其余 ${remaining.length} 项</summary><div class="hotspot-resource-grid">${remaining.map(renderHotspotResourceCard).join("")}</div></details>` : ""}` : `<div class="screenshot-empty">${emptyText}</div>`}
      </section>`;
  }

  function renderHotspotSchedule(group) {
    const start = parseDate(group.start);
    const end = parseDate(group.end);
    const span = Math.max(1, daysBetween(start, end) + 1);
    return `
      <div class="hotspot-schedule" style="--schedule-span:${span}">
        ${group.activities.map((activity) => {
          const activityStart = parseDate(activity.start);
          const activityFinish = activityEnd(activity);
          const duration = daysBetween(activityStart, activityFinish) + 1;
          const quality = activity.highestSkinQuality;
          const isFree = activity.type === "活跃";
          const left = daysBetween(start, activityStart) / span * 100;
          const width = Math.max(1.5, (daysBetween(activityStart, activityFinish) + 1) / span * 100);
          return `<button type="button" class="hotspot-activity-row${quality ? " has-quality" : ""}${isFree ? " is-free" : ""}" data-activity-id="${activity.id}" data-activity-type="${escapeHtml(activity.type || "待判断")}" style="--schedule-left:${left}%;--schedule-width:${width}%;--schedule-accent:${rowAccent(activity)}">
            <span class="schedule-name">
              <span class="schedule-title-line">${qualityBadge(quality, "schedule-quality")}<strong title="${escapeHtml(activity.name)}">${escapeHtml(activity.name)}</strong>${isFree ? '<em class="schedule-free-tag">Free</em>' : ""}</span>
              <small>${formatDate(activity.start)} — ${activity.end ? formatDate(activity.end) : "结束待补"}<b class="schedule-duration">持续 ${duration} 天</b></small>
            </span>
            <span class="schedule-track" aria-hidden="true"><i title="持续 ${duration} 天"><span>${duration}天</span></i></span>
            <span class="schedule-arrow">›</span>
          </button>`;
        }).join("")}
      </div>`;
  }

  function openHotspotDrawer(hotspotId) {
    const group = hotspotGroups.find((item) => item.id === hotspotId);
    if (!group) return;
    state.selected = group;
    state.drawerImages = [];
    const activityEntries = group.activities.map((activity) => ({ activity }));
    const skinEntries = hotspotResourceEntries(group, true);
    const smallEntries = hotspotResourceEntries(group, false);
    const screenshot = group.activities.flatMap((activity) => activity.screenshots.map((image) => ({ ...image, activityName: activity.name })))[0];
    dom.drawer.classList.add("is-hotspot");
    dom.drawerContent.innerHTML = `
      <header class="drawer-hero hotspot-drawer-hero"${screenshot ? ` style="--hotspot-cover:url('${escapeHtml(screenshot.src).replace(/'/g, "%27")}')"` : ""}>
        <div class="drawer-kicker"><span>热点独立档期${group.segmentTotal > 1 ? ` ${group.segmentIndex}/${group.segmentTotal}` : ""}</span>${qualityBadge(group.highestSkinQuality)}<span>${group.activities.length} 个关联活动</span></div>
        <h2>${escapeHtml(group.name)}</h2>
        <div class="drawer-period">${formatDate(group.start)} — ${formatDate(group.end)}</div>
      </header>
      <section class="drawer-section hotspot-overview">
        <div class="section-heading"><h3>热点概览</h3><span>${daysBetween(parseDate(group.start), parseDate(group.end)) + 1} 天</span></div>
        ${renderDistribution(activityEntries, "个活动")}
      </section>
      ${renderHotspotResources("皮肤资源", skinEntries, "该热点暂无皮肤资源")}
      ${renderHotspotResources("小资源", smallEntries, "该热点暂无小资源")}
      <section class="drawer-section hotspot-schedule-section">
        <div class="section-heading"><h3>活动排期</h3><span>点击活动查看详情</span></div>
        ${renderHotspotSchedule(group)}
      </section>`;
    dom.backdrop.hidden = false;
    dom.drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => dom.drawer.classList.add("is-open"));
    document.body.style.overflow = "hidden";
    document.querySelectorAll(".hotspot-activity-row").forEach((button) => button.addEventListener("click", () => openDrawer(button.dataset.activityId, group.id)));
  }

  function openDrawer(activityId, parentHotspotId = null) {
    const activity = activities.find((item) => item.id === activityId);
    if (!activity) return;
    const parentHotspot = parentHotspotId ? hotspotGroups.find((item) => item.id === parentHotspotId) : null;
    state.selected = activity;
    dom.drawer.classList.remove("is-hotspot");
    const allQualities = activity.skinQualities.map((quality) => qualityBadge(quality)).join("");
    const hotspot = activity.hotspot ? `<span class="hotspot-chip">◆ ${renderLinkedText(activity.hotspot, activity.hotspotLinks)}</span>` : "";
    const tags = [...activity.subtypes, activity.target, activity.type].filter(Boolean);
    dom.drawerContent.innerHTML = `
      ${parentHotspot ? `<button type="button" class="drawer-back" id="backToHotspot">← 返回 ${escapeHtml(parentHotspot.name)}</button>` : ""}
      <header class="drawer-hero">
        <div class="drawer-kicker">${allQualities}<span>${activity.highestSkinQuality ? "含皮肤资源" : "活动详情"}</span>${hotspot}</div>
        <h2>${renderLinkedText(activity.name, activity.nameLinks)}</h2>
        <div class="drawer-period">${formatDate(activity.start)} — ${activity.end ? formatDate(activity.end) : "结束时间待补充"}</div>
      </header>
      <section class="drawer-section">
        <div class="section-heading"><h3>活动截图</h3><span>${activity.screenshots.length} 张</span></div>
        ${renderScreenshotGallery(activity)}
      </section>
      <section class="drawer-section">
        <div class="section-heading"><h3>活动简介</h3><span>基础规则 · 行为条件</span></div>
        <p class="activity-summary">${escapeHtml(activity.behavior)}</p>
        <div class="tag-row">${tags.map((tag) => `<span class="detail-tag">${escapeHtml(tag)}</span>`).join("")}</div>
      </section>
      <section class="drawer-section">
        <div class="section-heading"><h3>相关资源</h3><span>${activity.resources.length} 条</span></div>
        <div id="resourceContainer">${activity.resources.length ? renderResourceCards(activity.resources) : '<div class="screenshot-empty">该活动暂无关联资源</div>'}</div>
        <a class="drawer-link" href="${escapeHtml(recordUrlBase)}&amp;record=${escapeHtml(activity.id)}" target="_blank" rel="noreferrer">在飞书中查看原记录 ↗</a>
      </section>`;
    dom.backdrop.hidden = false;
    dom.drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => dom.drawer.classList.add("is-open"));
    document.body.style.overflow = "hidden";
    bindDrawerEvents(activity, parentHotspotId);
  }

  function bindDrawerEvents(activity, parentHotspotId = null) {
    document.querySelectorAll(".screenshot-thumb").forEach((button) => button.addEventListener("click", () => selectDrawerImage(Number(button.dataset.imageIndex))));
    const main = el("screenshotMain");
    if (main) {
      main.addEventListener("click", () => openLightbox(state.activeImage));
      main.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") openLightbox(state.activeImage); });
    }
    const showAll = el("showAllResources");
    if (showAll) showAll.addEventListener("click", () => { el("resourceContainer").innerHTML = renderResourceCards(activity.resources, true); });
    const back = el("backToHotspot");
    if (back && parentHotspotId) back.addEventListener("click", () => openHotspotDrawer(parentHotspotId));
  }

  function selectDrawerImage(index) {
    state.activeImage = index;
    const image = state.drawerImages[index];
    const main = el("screenshotMainImage");
    if (main) { main.src = image.src; main.alt = image.name; }
    document.querySelectorAll(".screenshot-thumb").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.imageIndex) === index));
  }

  function closeDrawer() {
    dom.drawer.classList.remove("is-open");
    dom.drawer.setAttribute("aria-hidden", "true");
    dom.backdrop.hidden = true;
    dom.drawer.classList.remove("is-hotspot");
    document.body.style.overflow = "";
  }

  function openLightbox(index) {
    if (!state.drawerImages.length) return;
    state.lightboxIndex = index;
    updateLightbox();
    dom.lightbox.hidden = false;
    dom.lightbox.setAttribute("aria-hidden", "false");
  }
  function updateLightbox() {
    const image = state.drawerImages[state.lightboxIndex];
    dom.lightboxImage.src = image.src;
    dom.lightboxCaption.textContent = `${state.lightboxIndex + 1} / ${state.drawerImages.length} · ${image.name}`;
    dom.lightboxPrev.hidden = state.drawerImages.length < 2;
    dom.lightboxNext.hidden = state.drawerImages.length < 2;
  }
  function moveLightbox(delta) {
    state.lightboxIndex = (state.lightboxIndex + delta + state.drawerImages.length) % state.drawerImages.length;
    updateLightbox();
  }
  function closeLightbox() { dom.lightbox.hidden = true; dom.lightbox.setAttribute("aria-hidden", "true"); }

  function scrollToToday() {
    const today = todayDate();
    if (today < state.start || today > state.end) {
      setWindow(state.windowDays || 30);
      requestAnimationFrame(scrollToToday);
      return;
    }
    const dayWidth = GRAIN[state.grain];
    const left = daysBetween(state.axisStart, today) * dayWidth;
    dom.viewport.scrollTo({ left: Math.max(0, left - dom.viewport.clientWidth / 2 + 308), behavior: "smooth" });
  }

  function resetFilters() {
    state.query = ""; state.type = "all"; state.quality = "all"; state.hotspot = "all";
    state.mode = "active"; state.grain = "week"; state.perspective = "activity";
    dom.search.value = ""; dom.type.value = "all"; dom.quality.value = "all"; dom.hotspot.value = ""; dom.hotspotClear.hidden = true;
    closeHotspotOptions();
    document.querySelectorAll("[data-perspective]").forEach((button) => button.classList.toggle("is-active", button.dataset.perspective === "activity"));
    document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.mode === "active"));
    document.querySelectorAll("[data-grain]").forEach((button) => button.classList.toggle("is-active", button.dataset.grain === "week"));
    setWindow(30);
  }

  function bindDragScroll() {
    const drag = { active: false, moved: false, startX: 0, scrollLeft: 0, pointerId: null };
    dom.viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag.active = true;
      drag.moved = false;
      drag.startX = event.clientX;
      drag.scrollLeft = dom.viewport.scrollLeft;
      drag.pointerId = event.pointerId;
      state.isDragging = true;
      dom.viewport.scrollTo({ left: drag.scrollLeft, behavior: "auto" });
    });
    const moveDrag = (event) => {
      if (!drag.active || event.pointerId !== drag.pointerId) return;
      const delta = event.clientX - drag.startX;
      if (Math.abs(delta) > 4 && !drag.moved) {
        drag.moved = true;
        dom.viewport.classList.add("is-dragging");
      }
      if (drag.moved) {
        event.preventDefault();
        dom.viewport.scrollLeft = drag.scrollLeft - delta / state.displayScale;
      }
    };
    const stopDrag = (event) => {
      if (!drag.active) return;
      if (event?.pointerId != null && event.pointerId !== drag.pointerId) return;
      drag.active = false;
      state.isDragging = false;
      dom.viewport.classList.remove("is-dragging");
      if (drag.moved) {
        state.suppressBarClick = true;
        requestAnimationFrame(() => { state.suppressBarClick = false; });
      }
      drag.pointerId = null;
    };
    window.addEventListener("pointermove", moveDrag, { passive: false });
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    window.addEventListener("blur", () => stopDrag());
    dom.viewport.addEventListener("dragstart", (event) => event.preventDefault());
  }

  function bindEvents() {
    let searchTimer;
    let hotspotTimer;
    dom.search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query = dom.search.value; state.shouldFocusWindow = true; render(); }, 120); });
    dom.start.addEventListener("change", () => { state.start = parseDate(dom.start.value); state.windowDays = daysBetween(state.start, state.end) + 1; state.shouldFocusWindow = true; document.querySelectorAll("[data-window]").forEach((b) => b.classList.remove("is-active")); render(); });
    dom.end.addEventListener("change", () => { state.end = parseDate(dom.end.value); state.windowDays = daysBetween(state.start, state.end) + 1; state.shouldFocusWindow = true; document.querySelectorAll("[data-window]").forEach((b) => b.classList.remove("is-active")); render(); });
    dom.type.addEventListener("change", () => { state.type = dom.type.value; state.shouldFocusWindow = true; render(); });
    dom.quality.addEventListener("change", () => { state.quality = dom.quality.value; state.shouldFocusWindow = true; render(); });
    dom.hotspot.addEventListener("input", () => {
      clearTimeout(hotspotTimer);
      dom.hotspotClear.hidden = !dom.hotspot.value;
      renderHotspotOptions(dom.hotspot.value, true);
      hotspotTimer = setTimeout(() => {
        const selectedGroup = selectedHotspotGroup(dom.hotspot.value);
        state.hotspot = normalizedHotspotFilter(dom.hotspot.value);
        if (selectedGroup) focusHotspotWindow(selectedGroup);
        state.shouldFocusWindow = true;
        render();
      }, 120);
    });
    const selectHotspotOption = (value) => {
      clearTimeout(hotspotTimer);
      dom.hotspot.value = value;
      dom.hotspotClear.hidden = !value;
      const selectedGroup = selectedHotspotGroup(value);
      state.hotspot = normalizedHotspotFilter(value);
      if (selectedGroup) focusHotspotWindow(selectedGroup);
      state.shouldFocusWindow = true;
      closeHotspotOptions();
      render();
    };
    dom.hotspot.addEventListener("focus", () => renderHotspotOptions(dom.hotspot.value, true));
    dom.hotspot.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (dom.hotspotOptions.hidden) renderHotspotOptions(dom.hotspot.value, true);
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = activeHotspotOptionIndex < 0
          ? (direction > 0 ? 0 : visibleHotspotOptions.length - 1)
          : activeHotspotOptionIndex + direction;
        activateHotspotOption(nextIndex);
      } else if (event.key === "Enter" && activeHotspotOptionIndex >= 0) {
        event.preventDefault();
        selectHotspotOption(visibleHotspotOptions[activeHotspotOptionIndex].value);
      } else if (event.key === "Escape") {
        closeHotspotOptions();
      }
    });
    dom.hotspotOptions.addEventListener("pointerdown", (event) => event.preventDefault());
    dom.hotspotOptions.addEventListener("click", (event) => {
      const option = event.target.closest(".hotspot-option");
      if (option) selectHotspotOption(option.dataset.optionValue);
    });
    dom.hotspotClear.addEventListener("click", () => {
      clearTimeout(hotspotTimer);
      dom.hotspot.value = "";
      dom.hotspotClear.hidden = true;
      state.hotspot = "all";
      state.shouldFocusWindow = true;
      render();
      dom.hotspot.focus();
      renderHotspotOptions("", true);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".hotspot-search-shell")) closeHotspotOptions();
    });
    dom.scaleDown.addEventListener("click", () => stepDisplayScale(-1));
    dom.scaleUp.addEventListener("click", () => stepDisplayScale(1));
    dom.reset.addEventListener("click", resetFilters);
    dom.today.addEventListener("click", scrollToToday);
    dom.previousWindow.addEventListener("click", () => panTimeline(-1));
    dom.nextWindow.addEventListener("click", () => panTimeline(1));
    document.querySelectorAll("[data-window]").forEach((button) => button.addEventListener("click", () => setWindow(button.dataset.window === "3y" ? "3y" : Number(button.dataset.window))));
    document.querySelectorAll("[data-perspective]").forEach((button) => button.addEventListener("click", () => {
      state.perspective = button.dataset.perspective;
      document.querySelectorAll("[data-perspective]").forEach((item) => item.classList.toggle("is-active", item === button));
      dom.viewport.scrollTop = 0;
      state.shouldFocusWindow = true;
      render();
    }));
    document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("is-active", item === button));
      state.shouldFocusWindow = true;
      render();
    }));
    document.querySelectorAll("[data-grain]").forEach((button) => button.addEventListener("click", () => {
      state.grain = button.dataset.grain;
      document.querySelectorAll("[data-grain]").forEach((item) => item.classList.toggle("is-active", item === button));
      state.shouldFocusWindow = true;
      render();
    }));
    dom.body.addEventListener("click", (event) => {
      const bar = event.target.closest(".gantt-bar");
      if (!bar || state.suppressBarClick) return;
      if (bar.dataset.hotspotId) openHotspotDrawer(bar.dataset.hotspotId);
      else if (bar.dataset.activityId) openDrawer(bar.dataset.activityId);
    });
    dom.drawerClose.addEventListener("click", closeDrawer);
    dom.backdrop.addEventListener("click", closeDrawer);
    dom.lightboxClose.addEventListener("click", closeLightbox);
    dom.lightboxPrev.addEventListener("click", () => moveLightbox(-1));
    dom.lightboxNext.addEventListener("click", () => moveLightbox(1));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !dom.lightbox.hidden) closeLightbox();
      else if (event.key === "Escape" && dom.drawer.classList.contains("is-open")) closeDrawer();
      else if (!dom.lightbox.hidden && event.key === "ArrowLeft") moveLightbox(-1);
      else if (!dom.lightbox.hidden && event.key === "ArrowRight") moveLightbox(1);
    });
    bindDragScroll();
  }

  dom.generatedAt.textContent = meta.generatedAt;
  dom.dataRange.textContent = `${formatDate(meta.minDate)} — ${formatDate(meta.maxDate)}`;
  populateHotspotFilter();
  applyDisplayScale(storedDisplayScale(), false);
  bindEvents();
  setWindow(30);
})();
