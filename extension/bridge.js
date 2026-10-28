// Runs on app.casalabs.com.do — reads the encrypted vault and passes it to the extension
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'GET_VAULT') return;
  try {
    // The web app stores the vault in localStorage under these keys
    const vault = localStorage.getItem('lm_vault') || localStorage.getItem('vault');
    const salt  = localStorage.getItem('lm_salt')  || localStorage.getItem('salt');
    // Also try IndexedDB key names the app might use
    const keys = Object.keys(localStorage);
    const data = {};
    keys.forEach(k => { data[k] = localStorage.getItem(k); });
    sendResponse({ ok: true, vault, salt, all: data });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
  return true;
});
