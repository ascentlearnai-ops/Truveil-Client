(function (root) {
  'use strict';
  const products = { 'truveil-recruiter': 'TruveilRecruiter', 'truveil-secure': 'TruveilSecure' };

  function validateMacManifest(manifest, app, version, arch) {
    if (!products[app] || !['arm64', 'x64'].includes(arch) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) return null;
    const filename = products[app] + '-' + version + '-mac-' + arch + '.dmg';
    if (!manifest || manifest.schema !== 2 || manifest.platform !== 'darwin' || manifest.arch !== arch
      || manifest.app !== app || manifest.version !== version || manifest.installer !== filename
      || !/^[a-f0-9]{64}$/.test(manifest.installerSha256)
      || !/^[a-f0-9]{64}$/.test(manifest.sourceHash)
      || !Number.isSafeInteger(manifest.installerBytes) || manifest.installerBytes <= 0
      || !['archive', 'signature', 'gatekeeper', 'notarization'].every(key => manifest.validated?.[key] === true)) return null;
    return { href: '/downloads/' + filename, checksum: '/downloads/' + filename + '.sha256' };
  }

  function mountDownloads(document, fetchManifest = root.fetch?.bind(root)) {
    const mac = document.getElementById('mac-download');
    const windows = document.getElementById('windows-download');
    if (!mac || !windows) return;
    const status = document.getElementById('mac-download-status');
    const link = document.getElementById('mac-download-link');
    const checksum = document.getElementById('mac-checksum-link');
    const platforms = [...document.querySelectorAll('input[name="download-platform"]')];
    const architectures = [...document.querySelectorAll('input[name="download-arch"]')];
    let generation = 0;
    let controller;
    function clearLinks() {
      for (const element of [link, checksum]) { element.hidden = true; element.removeAttribute('href'); }
    }
    async function update() {
      const request = ++generation;
      controller?.abort();
      clearLinks();
      const showMac = platforms.find(input => input.checked)?.value === 'darwin';
      mac.hidden = !showMac;
      windows.hidden = showMac;
      if (!showMac) return;
      status.textContent = 'Checking Mac installer availability...';
      const arch = architectures.find(input => input.checked)?.value;
      controller = new AbortController();
      try {
        if (!fetchManifest || !['arm64', 'x64'].includes(arch)) throw new Error('Unavailable');
        const response = await fetchManifest('/downloads/release-manifest-mac-' + arch + '.json',
          { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error('Unavailable');
        const release = validateMacManifest(await response.json(), mac.dataset.app, mac.dataset.version, arch);
        if (!release) throw new Error('Unverified');
        if (request !== generation) return;
        link.href = release.href;
        checksum.href = release.checksum;
        link.textContent = 'Download for ' + (arch === 'arm64' ? 'Apple Silicon' : 'Intel Mac');
        link.hidden = false;
        checksum.hidden = false;
        status.textContent = 'Version ' + mac.dataset.version + ' - signed and notarized macOS installer.';
      } catch {
        if (request !== generation) return;
        status.textContent = 'Mac installer not published yet. Native Mac testing and release validation are required.';
      }
    }
    for (const input of [...platforms, ...architectures]) input.addEventListener('change', update);
    update();
    return { update };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { validateMacManifest, mountDownloads };
  else if (root.document) mountDownloads(root.document);
})(typeof globalThis === 'undefined' ? this : globalThis);
