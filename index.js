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

function getPresetManager() {
    const pm = ctx().getPresetManager(API_ID);
    if (!pm) {
        throw new Error('Chat Completion 프리셋 관리자를 찾을 수 없습니다.');
    }
    return pm;
}

/**
 * 화면과 무관한 순수 데이터 목록. (2차의 그룹 보기 / diff 비교도 이 데이터를 쓴다)
 * 마지막 수정일은 서버 API가 파일 시간을 주지 않아서 넣지 않는다.
 * @typedef {{ name: string, index: number, promptCount: number, isCurrent: boolean, archived: boolean }} PresetRow
 * @returns {PresetRow[]}
 */
function getPresetRows() {
    const pm = getPresetManager();
    const { presets, preset_names } = pm.getPresetList();
    const current = pm.getSelectedPresetName();
    const archived = new Set(getSettings().archived);

    return Object.entries(preset_names)
        .map(([name, index]) => {
            const preset = presets[index];
            return {
                name,
                index: Number(index),
                promptCount: Array.isArray(preset?.prompts) ? preset.prompts.length : 0,
                isCurrent: name === current,
                archived: archived.has(name),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 서버는 이름을 sanitize-filename으로 거른 뒤 파일을 지운다.
 * 걸러진 결과가 원래 이름과 다르면 엉뚱한 파일이 지워질 수 있으므로 그런 이름은 다루지 않는다.
 */
function isSafePresetName(name) {
    // sanitize-filename은 UTF-16 글자 수가 아니라 UTF-8 255바이트로 자른다
    if (!name || new TextEncoder().encode(name).length > 255) return false;
    if (/[/?<>\\:*|"]/.test(name)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x80-\x9f]/.test(name)) return false;
    if (/^\.+$/.test(name)) return false;
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) return false;
    if (/[. ]+$/.test(name)) return false;
    return true;
}

async function loadJSZip() {
    if (!('JSZip' in window)) {
        await import('/lib/jszip.min.js');
    }
    return window.JSZip;
}

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 서버에 지금 저장된 CC 프리셋 파일 내용을 그대로 읽어온다.
 * 이 탭의 메모리는 다른 탭에서 저장한 내용보다 오래됐을 수 있어서, 백업은 항상 서버 기준으로 만든다.
 * @returns {Promise<Map<string, string>>} 이름 → 파일 원문
 */
async function fetchServerPresets() {
    const response = await fetch('/api/settings/get', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
    });
    if (!response.ok) {
        throw new Error(`서버에서 프리셋을 읽지 못했습니다. (HTTP ${response.status})`);
    }
    const data = await response.json();
    const names = data?.openai_setting_names;
    const contents = data?.openai_settings;
    if (!Array.isArray(names) || !Array.isArray(contents) || names.length !== contents.length) {
        throw new Error('서버 응답 형식이 예상과 다릅니다.');
    }
    return new Map(names.map((name, i) => [name, contents[i]]));
}

/**
 * 서버에서 읽은 파일 원문으로 zip을 만들어 다운로드시킨다.
 * 하나라도 내용이 없으면 예외를 던져 삭제를 막는다.
 * @param {string[]} names
 * @param {Map<string, string>} serverFiles
 * @returns {Promise<string>} 다운로드한 파일 이름
 */
async function downloadBackupZip(names, serverFiles) {
    const JSZip = await loadJSZip();
    if (!JSZip) {
        throw new Error('JSZip을 불러오지 못했습니다.');
    }

    const zip = new JSZip();
    for (const name of names) {
        const raw = serverFiles.get(name);
        if (typeof raw !== 'string') {
            throw new Error(`"${name}" 프리셋 내용을 찾지 못했습니다.`);
        }
        zip.file(`${name}.json`, raw);
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const fileName = `preset-tidy-backup-${timestamp()}.zip`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return fileName;
}

/**
 * 프리셋 하나를 서버에서 지운 뒤, 성공했을 때만 드롭다운과 이름 목록에서 뺀다.
 * (기본 deletePreset은 서버 응답 전에 화면에서 먼저 빼서, 실패하면 화면과 파일이 어긋난다)
 * @returns {Promise<'deleted'|'failed'|'deletedButSelected'>}
 */
async function deleteOnePreset(name) {
    const pm = getPresetManager();
    const response = await fetch('/api/presets/delete', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ apiId: API_ID, name }),
    });
    if (!response.ok) {
        return 'failed';
    }

    const { eventSource, eventTypes } = ctx();
    await eventSource.emit(eventTypes.PRESET_DELETED, { apiId: API_ID, name });

    // 요청 중에 이 프리셋이 선택됐다면 화면을 건드리지 않는다 (선택 상태와 설정이 어긋나지 않게)
    if (name === pm.getSelectedPresetName()) {
        return 'deletedButSelected';
    }

    const { preset_names } = pm.getPresetList();
    const index = preset_names[name];
    if (index !== undefined) {
        delete preset_names[name];
        // option.text는 연속 공백을 줄이므로 이름이 아니라 value(배열 위치)로 찾는다
        $(pm.select).find('option').filter((_, el) => el.value === String(index)).remove();
    }
    return 'deleted';
}

/**
 * 백업 zip 다운로드 → 확인 창 → 삭제
 * @returns {Promise<boolean>} 삭제를 시도했으면 true
 */
async function deletePresetsWithBackup(names) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const current = getPresetManager().getSelectedPresetName();
    const targets = names.filter(name => name !== current);
    const unsafe = targets.filter(name => !isSafePresetName(name));
    const safe = targets.filter(name => isSafePresetName(name));

    if (unsafe.length) {
        toastr.warning(`이름에 특수 문자가 있어 이 도구로는 지울 수 없습니다: ${unsafe.join(', ')}`, '프리셋 정리');
    }
    if (!safe.length) {
        return false;
    }

    let fileName;
    let before;
    let toDelete;
    try {
        before = await fetchServerPresets();
        const missing = safe.filter(name => !before.has(name));
        if (missing.length) {
            toastr.warning(`서버에 파일이 없어 건너뜁니다: ${missing.join(', ')}`, '프리셋 정리');
        }
        toDelete = safe.filter(name => before.has(name));
        if (!toDelete.length) return false;
        fileName = await downloadBackupZip(toDelete, before);
    } catch (error) {
        console.error('[Preset Tidy] backup failed', error);
        toastr.error(`백업을 만들지 못해 삭제를 취소했습니다. ${error?.message ?? error}`, '프리셋 정리');
        return false;
    }

    const list = toDelete.map(name => `<li>${escapeHtml(name)}</li>`).join('');
    const confirmed = await callGenericPopup(`
        <div class="preset-tidy-confirm">
            <h3>프리셋 ${toDelete.length}개를 삭제할까요?</h3>
            <p>백업 파일 <b>${escapeHtml(fileName)}</b> 이 실제로 저장됐는지 먼저 확인하세요.<br>삭제는 되돌릴 수 없습니다.</p>
            <ul>${list}</ul>
        </div>`, POPUP_TYPE.CONFIRM, '', { okButton: '삭제', cancelButton: '취소', allowVerticalScrolling: true });

    if (!confirmed) {
        return false;
    }

    const failed = [];
    const changed = [];
    const needReload = [];
    let deleted = 0;
    for (const name of toDelete) {
        // 확인 창이 떠 있는 동안 선택 프리셋이 바뀌었을 수도 있으므로 매번 다시 확인
        if (name === getPresetManager().getSelectedPresetName()) {
            failed.push(name);
            continue;
        }
        try {
            // 다른 탭에서 저장됐다면 백업과 내용이 다르므로 지우지 않는다.
            // 지우기 바로 전에 하나씩 다시 읽는다. (서버 삭제 API는 내용을 비교하지 않는다)
            const latest = await fetchServerPresets();
            if (latest.get(name) !== before.get(name)) {
                changed.push(name);
                continue;
            }
            const result = await deleteOnePreset(name);
            if (result === 'failed') {
                failed.push(name);
            } else {
                deleted++;
                if (result === 'deletedButSelected') needReload.push(name);
            }
        } catch (error) {
            console.error('[Preset Tidy] delete failed', name, error);
            failed.push(name);
        }
    }

    ctx().saveSettingsDebounced();
    if (deleted) toastr.success(`프리셋 ${deleted}개를 삭제했습니다.`, '프리셋 정리');
    if (failed.length) toastr.error(`삭제하지 못한 프리셋: ${failed.join(', ')}`, '프리셋 정리');
    if (changed.length) toastr.warning(`백업 이후 내용이 바뀌어 건너뛰었습니다: ${changed.join(', ')}`, '프리셋 정리');
    if (needReload.length) toastr.warning(`삭제 중에 선택된 프리셋이 있습니다. 페이지를 새로고침하세요: ${needReload.join(', ')}`, '프리셋 정리');
    return true;
}

function getDropdown() {
    return /** @type {HTMLSelectElement|null} */ (document.getElementById('settings_preset_openai'));
}

/**
 * 보관한 프리셋의 <option>에 hidden을 붙인다. 파일과 <option> 자체는 그대로 두므로
 * /preset 명령어와 연결 프로필은 보관한 프리셋도 계속 찾을 수 있다.
 * 현재 선택된 프리셋은 숨기지 않는다. (iOS Safari는 option hidden을 무시한다)
 */
function applyArchiveToDropdown() {
    const select = getDropdown();
    if (!select) return;
    const archived = new Set(getSettings().archived);
    // option.text는 연속 공백을 줄이므로, 프리셋 관리자(jQuery .text())와 같은 textContent로 비교한다
    const current = select.selectedOptions[0]?.textContent;
    for (const option of select.options) {
        const hide = archived.has(option.textContent) && option.textContent !== current;
        if (option.hidden !== hide) option.hidden = hide;
    }
}

function setArchived(names, archive) {
    const settings = getSettings();
    const set = new Set(settings.archived);
    for (const name of names) {
        if (archive) set.add(name);
        else set.delete(name);
    }
    settings.archived = [...set];
    ctx().saveSettingsDebounced();
    applyArchiveToDropdown();
}

async function archivePresets(names) {
    const current = getPresetManager().getSelectedPresetName();
    const targets = names.filter(name => name !== current);
    if (!targets.length) return false;
    setArchived(targets, true);
    toastr.success(`프리셋 ${targets.length}개를 보관함으로 옮겼습니다.`, '프리셋 정리');
    return true;
}

async function unarchivePresets(names) {
    if (!names.length) return false;
    setArchived(names, false);
    toastr.success(`프리셋 ${names.length}개를 보관함에서 꺼냈습니다.`, '프리셋 정리');
    return true;
}

/** 드롭다운에 <option>이 추가·삭제될 때(저장, 가져오기, 이름 변경 등)마다 숨김을 다시 적용한다. */
function watchDropdown() {
    const select = getDropdown();
    if (select) {
        // childList만 본다. hidden 속성 변경은 감시 대상이 아니라서 무한 반복이 생기지 않는다.
        new MutationObserver(applyArchiveToDropdown).observe(select, { childList: true });
    }

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, applyArchiveToDropdown);
    eventSource.on(eventTypes.SETTINGS_LOADED, applyArchiveToDropdown);
    eventSource.on(eventTypes.PRESET_RENAMED, ({ apiId, oldName, newName }) => {
        if (apiId !== API_ID) return;
        const settings = getSettings();
        if (!settings.archived.includes(oldName)) return;
        settings.archived = settings.archived.map(name => name === oldName ? newName : name);
        ctx().saveSettingsDebounced();
        applyArchiveToDropdown();
    });
    eventSource.on(eventTypes.PRESET_DELETED, ({ apiId, name }) => {
        if (apiId !== API_ID) return;
        const settings = getSettings();
        if (!settings.archived.includes(name)) return;
        settings.archived = settings.archived.filter(x => x !== name);
        ctx().saveSettingsDebounced();
    });
}

function createTidyView(root) {
    const state = {
        /** @type {'active'|'archived'} */
        tab: 'active',
        query: '',
        /** @type {Set<string>} */
        selected: new Set(),
    };

    root.innerHTML = `
        <h3>프리셋 정리 <small>(Chat Completion)</small></h3>
        <div class="preset-tidy-tabs">
            <div class="menu_button preset-tidy-tab" data-tab="active">프리셋</div>
            <div class="menu_button preset-tidy-tab" data-tab="archived">보관함</div>
        </div>
        <div class="preset-tidy-toolbar">
            <input type="search" class="text_pole preset-tidy-search" placeholder="이름 검색">
        </div>
        <div class="preset-tidy-tablewrap">
            <table class="preset-tidy-table">
                <thead>
                    <tr>
                        <th class="preset-tidy-check"><input type="checkbox" class="preset-tidy-all" title="보이는 항목 전체 선택/해제"></th>
                        <th>이름</th>
                        <th class="preset-tidy-num">프롬프트 블록</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
        <div class="preset-tidy-actions">
            <span class="preset-tidy-count"></span>
            <div class="menu_button menu_button_icon preset-tidy-archive" title="드롭다운에서 숨기기 (파일은 그대로)">
                <i class="fa-solid fa-box-archive"></i><span>보관</span>
            </div>
            <div class="menu_button menu_button_icon preset-tidy-unarchive" title="드롭다운에 다시 보이기">
                <i class="fa-solid fa-box-open"></i><span>꺼내기</span>
            </div>
            <div class="menu_button menu_button_icon preset-tidy-delete" title="선택한 프리셋을 백업 후 삭제">
                <i class="fa-solid fa-trash-can"></i><span>삭제</span>
            </div>
        </div>`;

    const $ = (selector) => root.querySelector(selector);
    const tbody = $('tbody');
    const allBox = $('.preset-tidy-all');

    function visibleRows() {
        const query = state.query.trim().toLowerCase();
        const wantArchived = state.tab === 'archived';
        return getPresetRows().filter(row => row.archived === wantArchived
            && (!query || row.name.toLowerCase().includes(query)));
    }

    /** 실제로 작업 대상이 되는 이름들: 선택됐고, 지금 보이고, 사용 중이 아닌 것 */
    function selectedNames() {
        return visibleRows().filter(row => !row.isCurrent && state.selected.has(row.name)).map(row => row.name);
    }

    function render() {
        const rows = visibleRows();
        const selectable = rows.filter(row => !row.isCurrent);

        // 안 보이게 되었거나 사라진/사용 중인 항목은 선택에서 뺀다 (안 보이는 걸 지우는 사고 방지)
        const keep = new Set(selectable.map(row => row.name));
        for (const name of state.selected) {
            if (!keep.has(name)) state.selected.delete(name);
        }

        tbody.innerHTML = rows.length
            ? rows.map(row => `
                <tr class="${row.isCurrent ? 'preset-tidy-current' : ''}">
                    <td class="preset-tidy-check">
                        <input type="checkbox" data-name="${escapeHtml(row.name)}"
                            ${state.selected.has(row.name) ? 'checked' : ''}
                            ${row.isCurrent ? 'disabled title="현재 사용 중인 프리셋은 선택할 수 없습니다"' : ''}>
                    </td>
                    <td class="preset-tidy-name">
                        ${escapeHtml(row.name)}
                        ${row.isCurrent ? '<span class="preset-tidy-badge">사용 중</span>' : ''}
                    </td>
                    <td class="preset-tidy-num">${row.promptCount}</td>
                </tr>`).join('')
            : `<tr><td colspan="3" class="preset-tidy-empty">${state.tab === 'archived' ? '보관한 프리셋이 없습니다.' : '프리셋이 없습니다.'}</td></tr>`;

        const archivedCount = getPresetRows().filter(row => row.archived).length;
        root.querySelectorAll('.preset-tidy-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === state.tab);
        });
        $('.preset-tidy-tab[data-tab="archived"]').textContent = `보관함 (${archivedCount})`;
        $('.preset-tidy-archive').style.display = state.tab === 'active' ? '' : 'none';
        $('.preset-tidy-unarchive').style.display = state.tab === 'archived' ? '' : 'none';

        const count = selectable.filter(row => state.selected.has(row.name)).length;
        allBox.checked = selectable.length > 0 && count === selectable.length;
        allBox.indeterminate = count > 0 && count < selectable.length;
        allBox.disabled = selectable.length === 0;
        $('.preset-tidy-count').textContent = `${rows.length}개 중 ${count}개 선택`;
        root.querySelectorAll('.preset-tidy-actions .menu_button').forEach(button => {
            button.classList.toggle('disabled', count === 0 || busy);
        });
    }

    let busy = false;
    async function runAction(action) {
        const names = selectedNames();
        if (busy || !names.length) return;
        busy = true;
        render();
        try {
            if (await action(names)) state.selected.clear();
        } finally {
            busy = false;
            render();
        }
    }

    $('.preset-tidy-delete').addEventListener('click', () => runAction(deletePresetsWithBackup));
    $('.preset-tidy-archive').addEventListener('click', () => runAction(archivePresets));
    $('.preset-tidy-unarchive').addEventListener('click', () => runAction(unarchivePresets));

    root.querySelectorAll('.preset-tidy-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (busy || state.tab === tab.dataset.tab) return;
            state.tab = /** @type {'active'|'archived'} */ (tab.dataset.tab);
            state.selected.clear();
            render();
        });
    });

    $('.preset-tidy-search').addEventListener('input', (e) => {
        state.query = e.target.value;
        render();
    });

    allBox.addEventListener('change', () => {
        const selectable = visibleRows().filter(row => !row.isCurrent);
        for (const row of selectable) {
            if (allBox.checked) state.selected.add(row.name);
            else state.selected.delete(row.name);
        }
        render();
    });

    tbody.addEventListener('change', (e) => {
        const box = e.target;
        if (!(box instanceof HTMLInputElement) || !box.dataset.name) return;
        if (box.checked) state.selected.add(box.dataset.name);
        else state.selected.delete(box.dataset.name);
        render();
    });

    render();
    return { render, selectedNames, isBusy: () => busy };
}

async function openTidyWindow() {
    const { Popup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'preset-tidy';

    let view;
    try {
        view = createTidyView(root);
    } catch (error) {
        console.error('[Preset Tidy]', error);
        toastr.error(String(error?.message ?? error), '프리셋 정리');
        return;
    }

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: '닫기',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        // 작업 중에 창을 닫으면 뒤의 드롭다운에서 지우는 중인 프리셋을 고를 수 있으므로 막는다
        onClosing: () => {
            if (view.isBusy()) {
                toastr.info('작업이 끝난 뒤에 닫을 수 있습니다.', '프리셋 정리');
                return false;
            }
            return true;
        },
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
    watchDropdown();
    applyArchiveToDropdown();
});
