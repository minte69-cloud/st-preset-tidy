// Preset Tidy — Chat Completion 프리셋 정리 도구 (SillyTavern 1.19)
// 내부 API는 import 경로가 설치 위치마다 달라서 전부 SillyTavern.getContext()로만 접근한다.

const MODULE = 'presetTidy';
const API_ID = 'openai';

const ctx = () => SillyTavern.getContext();

/** 확장 설정 (extension_settings.presetTidy) */
function getSettings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') {
        all[MODULE] = {};
    }
    if (!Array.isArray(all[MODULE].archived)) {
        all[MODULE].archived = [];
    }
    return all[MODULE];
}

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

async function openTidyWindow() {
    const { Popup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'preset-tidy';
    root.innerHTML = '<h3>프리셋 정리</h3>';

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: '닫기',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    await popup.show();
}

function addWandMenuItem() {
    const item = document.createElement('div');
    item.id = 'preset_tidy_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-broom extensionsMenuExtensionButton"></div>프리셋 정리';
    item.addEventListener('click', openTidyWindow);
    document.getElementById('extensionsMenu')?.append(item);
}

jQuery(() => {
    getSettings();
    addWandMenuItem();
});
