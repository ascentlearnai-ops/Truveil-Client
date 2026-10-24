"use strict";

const audience = document.body.dataset.audience;
const candidateSite = audience === "candidate";
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const navButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#main-navigation");

if (navButton && navigation) {
  navButton.addEventListener("click", () => {
    const open = navButton.getAttribute("aria-expanded") !== "true";
    navButton.setAttribute("aria-expanded", String(open));
    navButton.setAttribute(
      "aria-label",
      open ? "Close navigation" : "Open navigation",
    );
    navigation.classList.toggle("is-open", open);
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      navigation.classList.remove("is-open");
      navButton.setAttribute("aria-expanded", "false");
      navButton.setAttribute("aria-label", "Open navigation");
    }
  });
}

if (
  "IntersectionObserver" in window &&
  !motionQuery.matches &&
  !navigator.connection?.saveData
) {
  document.documentElement.classList.add("js");
  document
    .querySelectorAll(
      "main h2, main .section-kicker, main .boundary-list > li, main .workflow-list > li",
    )
    .forEach((element) => {
      if (!element.closest(".cinema-hero, .scroll-story, .tour, .reveal"))
        element.classList.add("reveal");
    });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.remove("pending");
          entry.target.classList.add("revealed");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.05 },
  );
  document.querySelectorAll(".reveal").forEach((element) => {
    if (element.getBoundingClientRect().top > innerHeight)
      element.classList.add("pending");
    observer.observe(element);
  });
  motionQuery.addEventListener("change", () => {
    if (motionQuery.matches)
      document
        .querySelectorAll(".pending")
        .forEach((element) => element.classList.remove("pending"));
  });
}

const sceneMascots = [...document.querySelectorAll('main img[src*="/tavi"]')];
if ("IntersectionObserver" in window && sceneMascots.length) {
  const mascotObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        entry.target.classList.toggle("mascot-in-view", entry.isIntersecting);
    },
    { threshold: 0.25 },
  );
  sceneMascots.forEach((element) => {
    element.classList.add("mascot-motion");
    mascotObserver.observe(element);
  });
  const syncSceneMotion = () =>
    document.body.classList.toggle(
      "ambient-still",
      document.hidden ||
        motionQuery.matches ||
        Boolean(navigator.connection?.saveData),
    );
  document.addEventListener("visibilitychange", syncSceneMotion);
  motionQuery.addEventListener("change", syncSceneMotion);
  navigator.connection?.addEventListener?.("change", syncSceneMotion);
  syncSceneMotion();
}

const helperButton = document.querySelector(".helper-toggle");
const helperPanel = document.querySelector(".helper-panel");
function closeHelp() {
  if (!helperPanel || !helperButton) return;
  helperPanel.hidden = true;
  helperButton.setAttribute("aria-expanded", "false");
}
if (helperButton && helperPanel) {
  helperButton.addEventListener("click", () => {
    const open = helperPanel.hidden;
    helperPanel.hidden = !open;
    helperButton.setAttribute("aria-expanded", String(open));
    if (open) helperPanel.querySelector(".helper-close").focus();
  });
  helperPanel.querySelector(".helper-close").addEventListener("click", () => {
    closeHelp();
    helperButton.focus();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".helper")) closeHelp();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (helperPanel && !helperPanel.hidden) {
    closeHelp();
    helperButton.focus();
  }
  if (navigation?.classList.contains("is-open")) {
    navigation.classList.remove("is-open");
    navButton.setAttribute("aria-expanded", "false");
    navButton.setAttribute("aria-label", "Open navigation");
    navButton.focus();
  }
});

const tourTabs = [...document.querySelectorAll("[data-tour]")];
function selectTour(tab) {
  for (const item of tourTabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden =
      !selected;
  }
}
tourTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTour(tab));
  tab.addEventListener("keydown", (event) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (index + 1) % tourTabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (index - 1 + tourTabs.length) % tourTabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tourTabs.length - 1;
    else return;
    event.preventDefault();
    selectTour(tourTabs[next]);
    tourTabs[next].focus();
  });
});

let toastTimer;
function showToast(message) {
  const element = document.querySelector(".toast");
  if (!element) return;
  clearTimeout(toastTimer);
  element.textContent = message;
  element.hidden = false;
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 4500);
}
document
  .querySelector("[data-copy-invite]")
  ?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(
        "Sample Truveil invitation: TRV-482910. This code is a demo only. Your interviewer will send your real invitation.",
      );
      showToast("Sample invitation copied. This is a demo code.");
    } catch {
      showToast("Clipboard unavailable. Sample code: TRV-482910.");
    }
  });

function normalizeCode(raw) {
  const cleaned = raw.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(cleaned) ? "TRV-" + cleaned : cleaned;
}
function validInviteCode(code) {
  return /^TRV-[A-Z0-9]{6}$/.test(code);
}
const inviteParams = new URLSearchParams(location.search);
const inviteCode = normalizeCode(inviteParams.get("code") || "");
function applyInvitation(code) {
  const protocolUrl = "truveil://join?code=" + encodeURIComponent(code);
  document.querySelectorAll(".code-preview").forEach((element) => {
    element.textContent = code;
  });
  document.querySelectorAll("[data-invite-open]").forEach((link) => {
    link.href = protocolUrl;
  });
  document.querySelectorAll("[data-invite-banner]").forEach((element) => {
    element.hidden = false;
  });
  document.querySelectorAll('input[name="code"]').forEach((input) => {
    input.value = code;
  });
  document.querySelectorAll("a[href]").forEach((link) => {
    const target = new URL(link.href);
    if (
      target.origin !== location.origin ||
      !/\/(?:login|guide)\.html$/.test(target.pathname)
    )
      return;
    target.searchParams.set("code", code);
    link.href = target.href;
  });
}
if (candidateSite && validInviteCode(inviteCode)) applyInvitation(inviteCode);

document.querySelectorAll("[data-invite-form]").forEach((form) => {
  const input = form.elements.namedItem("code");
  const error = form.querySelector("[data-invite-error]");
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    input.removeAttribute("aria-invalid");
    if (error) error.textContent = "";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = normalizeCode(input.value);
    if (!validInviteCode(code)) {
      input.setAttribute("aria-invalid", "true");
      if (error)
        error.textContent =
          "Use the TRV code in your invitation, for example TRV-123456.";
      input.focus();
      return;
    }
    applyInvitation(code);
    if (form.hasAttribute("data-open-desktop")) {
      const result = document.querySelector("[data-invite-result]");
      const open = result.querySelector("[data-invite-open]");
      open.href = "truveil://join?code=" + encodeURIComponent(code);
      result.querySelector(".code-preview").textContent = code;
      result.hidden = false;
      open.focus();
    } else {
      location.href = "login.html?code=" + encodeURIComponent(code);
    }
  });
});

async function request(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: payload ? "POST" : "GET",
    credentials: "same-origin",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 429)
    throw new Error(
      "A few too many attempts. Please wait before trying again.",
    );
  if (response.status === 503)
    throw new Error(
      "This service is temporarily unavailable. Please try again later or contact support@truveil.com.",
    );
  if (!response.ok) {
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 422
    )
      throw new Error(
        endpoint === "/api/auth"
          ? "Check your details and try again. Email codes may have expired."
          : "Check your signup details and consent, then try again.",
      );
    throw new Error(
      "We could not complete that request. Please try again shortly.",
    );
  }
  return response.json();
}
const buttonContents = new WeakMap();
function busy(form, pending) {
  const submit = form.querySelector('button[type="submit"]');
  if (!submit) return;
  submit.disabled = pending;
  form.setAttribute("aria-busy", String(pending));
  if (pending) {
    buttonContents.set(submit, [...submit.childNodes]);
    submit.replaceChildren("One moment...");
  } else if (buttonContents.has(submit)) {
    submit.replaceChildren(...buttonContents.get(submit));
    buttonContents.delete(submit);
  }
}
function showFormError(element, error) {
  element.classList.add("error");
  element.textContent =
    error.name === "TimeoutError" || error.name === "TypeError"
      ? "We could not connect. Check your connection and try again."
      : error.message;
}
const waitlistForm = document.querySelector("[data-waitlist-form]");
if (waitlistForm) {
  waitlistForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      waitlistForm.getAttribute("aria-busy") === "true" ||
      !waitlistForm.reportValidity()
    )
      return;
    const status = waitlistForm.querySelector('[role="status"]');
    const data = new FormData(waitlistForm);
    status.textContent = "";
    busy(waitlistForm, true);
    try {
      await request("/api/waitlist", {
        email: data.get("email").trim(),
        name: data.get("name").trim(),
        company: data.get("company")?.trim() || "",
        audience: data.get("audience"),
        consent: data.get("consent") === "on",
        website: data.get("website"),
      });
      waitlistForm.hidden = true;
      const success = document.querySelector("[data-waitlist-success]");
      success.hidden = false;
      success.querySelector("h2").focus();
    } catch (error) {
      showFormError(status, error);
    } finally {
      busy(waitlistForm, false);
    }
  });
}

const loginForm = document.querySelector("[data-login-form]");
const verifyForm = document.querySelector("[data-verify-form]");
let loginEmail = "";
if (loginForm && verifyForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      loginForm.getAttribute("aria-busy") === "true" ||
      !loginForm.reportValidity()
    )
      return;
    const status = loginForm.querySelector('[role="status"]');
    status.textContent = "";
    loginEmail = new FormData(loginForm).get("email").trim();
    busy(loginForm, true);
    try {
      await request("/api/auth", { action: "send", email: loginEmail });
      loginForm.hidden = true;
      verifyForm.hidden = false;
      document.querySelector("[data-login-email]").textContent = loginEmail;
      verifyForm.querySelector("input").focus();
    } catch (error) {
      showFormError(status, error);
    } finally {
      busy(loginForm, false);
    }
  });
  verifyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      verifyForm.getAttribute("aria-busy") === "true" ||
      !verifyForm.reportValidity()
    )
      return;
    const status = verifyForm.querySelector('[role="status"]');
    status.textContent = "";
    busy(verifyForm, true);
    try {
      const data = await request("/api/auth", {
        action: "verify",
        email: loginEmail,
        code: new FormData(verifyForm).get("code").trim(),
      });
      verifyForm.hidden = true;
      showAccount(data.user.email);
    } catch (error) {
      showFormError(status, error);
    } finally {
      busy(verifyForm, false);
    }
  });
  document
    .querySelector("[data-change-email]")
    .addEventListener("click", () => {
      verifyForm.hidden = true;
      loginForm.hidden = false;
      loginForm.querySelector("input").focus();
    });
  request("/api/auth")
    .then((data) => {
      if (data.user) {
        loginForm.hidden = true;
        showAccount(data.user.email);
      }
    })
    .catch(() => {
      /* The email form remains available when session lookup fails. */
    });
}
function showAccount(email) {
  const account = document.querySelector("[data-account]");
  if (!account) return;
  account.hidden = false;
  account.querySelector("[data-account-email]").textContent = email;
  account.querySelector("h2").focus();
}
document
  .querySelector("[data-signout]")
  ?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await request("/api/auth", { action: "logout" });
      location.reload();
    } catch {
      button.disabled = false;
      showToast("Could not sign out. Please try again.");
    }
  });

const checks = [...document.querySelectorAll("[data-prep-check]")];
if (checks.length) {
  let stored = [];
  try {
    stored = JSON.parse(
      localStorage.getItem("truveil-prep-" + audience) || "[]",
    );
  } catch {
    stored = [];
  }
  if (Array.isArray(stored))
    checks.forEach((input) => {
      input.checked = stored.includes(input.value);
    });
  function updatePreparation() {
    const completed = checks
      .filter((input) => input.checked)
      .map((input) => input.value);
    const progress = document.querySelector("[data-prep-progress]");
    progress.style.width = (completed.length / checks.length) * 100 + "%";
    const label = document.querySelector("[data-prep-count]");
    label.textContent =
      completed.length + " of " + checks.length + " steps ready";
    document.querySelector("[data-prep-complete]").hidden =
      completed.length !== checks.length;
    try {
      localStorage.setItem(
        "truveil-prep-" + audience,
        JSON.stringify(completed),
      );
    } catch {
      /* The checklist still works when local storage is unavailable. */
    }
  }
  checks.forEach((input) =>
    input.addEventListener("change", updatePreparation),
  );
  updatePreparation();
}
