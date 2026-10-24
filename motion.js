"use strict";

(() => {
  const hero = document.querySelector(".cinema-hero");
  if (!hero) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const desktop = matchMedia("(min-width: 801px) and (min-height: 741px)");
  const video = hero.querySelector("video");
  const lookVideo = hero.querySelector(".cinema-look");
  const lookFps = Number(lookVideo?.dataset.fps) || 60;
  const media = hero.querySelector(".cinema-media");
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const toggle = hero.querySelector(".motion-toggle");
  const story = document.querySelector(".scroll-story");
  const steps = [...document.querySelectorAll(".story-step")];
  const scenes = [...document.querySelectorAll(".story-scene")];
  const proof = hero.querySelector(".hero-proof");
  let userPaused = false;
  let userStarted = false;
  let inView = !("IntersectionObserver" in window);
  let frame = 0;
  let active = -1;
  let failed = false;
  let lookRequested = false;
  let lookReady = false;
  let lookFailed = false;
  let lookFrame = 0;
  let lookTarget = 0.5;
  const initialAnchor = document.getElementById(location.hash.slice(1));
  let awaitingAnchor = Boolean(
    initialAnchor &&
      !hero.contains(initialAnchor) &&
      !initialAnchor.contains(hero),
  );

  document.documentElement.classList.add("story-ready");
  function allowed() {
    return (
      !userPaused &&
      (!reduced.matches || userStarted) &&
      (!navigator.connection?.saveData || userStarted)
    );
  }
  function renderToggle() {
    const paused = failed || !allowed() || (!looking() && video.paused);
    toggle.classList.toggle("is-paused", paused);
    toggle.setAttribute(
      "aria-label",
      paused ? "Play Tavi animation" : "Pause Tavi animation",
    );
    toggle.title = paused ? "Play Tavi animation" : "Pause Tavi animation";
  }
  function canLook() {
    return (
      lookVideo &&
      finePointer.matches &&
      !reduced.matches &&
      allowed() &&
      inView &&
      !document.hidden &&
      !lookFailed &&
      !failed
    );
  }
  function looking() {
    return Boolean(canLook() && lookRequested && lookReady);
  }
  function requestLookFrame() {
    if (!lookFrame && canLook() && lookRequested)
      lookFrame = requestAnimationFrame(updateLook);
  }
  function updateLook() {
    lookFrame = 0;
    if (
      !canLook() ||
      !lookRequested ||
      !Number.isFinite(lookVideo.duration) ||
      lookVideo.readyState < 2 ||
      lookVideo.seeking
    )
      return;
    // Coalesce pointer input into one seek to the newest pose. Easing after each
    // asynchronous seek compounds decoder latency and makes the character trail.
    const lastFrame = Math.max(0, lookVideo.duration - 1 / lookFps);
    const time = Math.min(
      lastFrame,
      Math.round(lookTarget * lastFrame * lookFps) / lookFps,
    );
    if (Math.abs(lookVideo.currentTime - time) > 0.5 / lookFps)
      lookVideo.currentTime = time;
    else if (!lookReady) {
      lookReady = true;
      synchronizePlayback();
    }
  }
  function releaseLook() {
    lookRequested = false;
    cancelAnimationFrame(lookFrame);
    lookFrame = 0;
    synchronizePlayback();
  }
  if (lookVideo) {
    lookVideo.addEventListener("loadeddata", requestLookFrame);
    lookVideo.addEventListener("seeked", () => {
      lookReady = true;
      if (!media.classList.contains("is-looking")) synchronizePlayback();
      requestLookFrame();
    });
    lookVideo.addEventListener("error", () => {
      lookFailed = true;
      releaseLook();
    });
    document.addEventListener(
      "pointermove",
      (event) => {
        if (!canLook() || event.pointerType === "touch") return;
        lookTarget = Math.max(
          0,
          Math.min(
            1,
            event.clientX / Math.max(1, document.documentElement.clientWidth),
          ),
        );
        lookRequested = true;
        if (!lookVideo.getAttribute("src")) {
          lookVideo.src = lookVideo.dataset.src;
          lookVideo.load();
        }
        if (lookReady && !media.classList.contains("is-looking"))
          synchronizePlayback();
        requestLookFrame();
      },
      { passive: true },
    );
    document.documentElement.addEventListener("pointerleave", releaseLook);
    document.addEventListener("keydown", releaseLook);
    window.addEventListener("blur", releaseLook);
    finePointer.addEventListener("change", releaseLook);
  }
  function synchronizePlayback() {
    document.body.classList.toggle(
      "motion-paused",
      !allowed() || reduced.matches,
    );
    const frozenLook =
      userPaused &&
      lookRequested &&
      lookReady &&
      finePointer.matches &&
      !reduced.matches &&
      inView &&
      !document.hidden &&
      !lookFailed &&
      !failed;
    media.classList.toggle("is-looking", looking() || frozenLook);
    if (!canLook()) {
      cancelAnimationFrame(lookFrame);
      lookFrame = 0;
      if (!frozenLook) lookRequested = false;
    }
    if (allowed() && inView && !document.hidden && !failed && !looking()) {
      if (!video.getAttribute("src")) video.src = video.dataset.src;
      video
        .play()
        .then(renderToggle)
        .catch(() => {
          renderToggle();
        });
    } else {
      video.pause();
      renderToggle();
    }
    requestFrame();
    if (looking()) requestLookFrame();
  }
  video.addEventListener("playing", () => {
    video.classList.add("is-ready");
    renderToggle();
  });
  video.addEventListener("play", renderToggle);
  video.addEventListener("pause", renderToggle);
  video.addEventListener("error", () => {
    failed = true;
    video.classList.remove("is-ready");
    toggle.hidden = true;
    hero.querySelector("[data-film-credit]").textContent =
      "Tavi, your interview companion";
  });
  toggle.addEventListener("click", () => {
    awaitingAnchor = false;
    const bounds = hero.getBoundingClientRect();
    inView = bounds.bottom > 0 && bounds.top < innerHeight;
    userPaused = allowed() && (looking() || !video.paused);
    userStarted = true;
    synchronizePlayback();
  });
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Anchor restoration can happen after the first observer notification.
        if (!entry.isIntersecting) awaitingAnchor = false;
        inView = entry.isIntersecting && !awaitingAnchor;
        synchronizePlayback();
      },
      { threshold: 0.08 },
    );
    observer.observe(hero);
  }

  function select(index) {
    if (index === active) return;
    active = index;
    steps.forEach((step, i) => {
      step.classList.toggle("is-active", i === index);
      const button = step.querySelector("button");
      if (i === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    scenes.forEach((scene, i) => {
      const selected = i === index || !desktop.matches || reduced.matches;
      scene.classList.toggle("is-active", i === index);
      scene.setAttribute("aria-hidden", String(!selected));
    });
  }
  function update() {
    frame = 0;
    if (!story) return;
    const rect = story.getBoundingClientRect();
    const range = Math.max(1, rect.height - innerHeight + 78);
    const progress = Math.max(0, Math.min(1, (78 - rect.top) / range));
    if (desktop.matches && !reduced.matches) {
      select(Math.min(2, Math.floor(progress * 3)));
      story.style.setProperty("--story-progress", String(progress));
    }
    const distance = Math.max(
      0,
      Math.min(380, -hero.getBoundingClientRect().top),
    );
    proof.style.setProperty(
      "--proof-y",
      allowed() && !reduced.matches ? `${-distance * 0.075}px` : "0px",
    );
    proof.style.setProperty(
      "--proof-angle",
      allowed() && !reduced.matches ? `${-2 + distance / 190}deg` : "0deg",
    );
  }
  function requestFrame() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  steps.forEach((step, index) => {
    step.querySelector("button").addEventListener("click", () => {
      select(index);
      if (desktop.matches && !reduced.matches) {
        const range = story.offsetHeight - innerHeight + 78;
        const top = story.getBoundingClientRect().top + scrollY - 78;
        window.scrollTo({
          top: top + ((index + 0.15) / 3) * range,
          behavior: "smooth",
        });
      } else
        scenes[index].scrollIntoView({
          behavior: reduced.matches ? "instant" : "smooth",
          block: "center",
        });
    });
  });
  function mediaChange() {
    active = -1;
    select(0);
    synchronizePlayback();
  }
  reduced.addEventListener("change", () => {
    userStarted = false;
    mediaChange();
  });
  desktop.addEventListener("change", mediaChange);
  document.addEventListener("visibilitychange", synchronizePlayback);
  window.addEventListener("scroll", requestFrame, { passive: true });
  window.addEventListener("resize", requestFrame, { passive: true });
  select(0);
  synchronizePlayback();
})();
