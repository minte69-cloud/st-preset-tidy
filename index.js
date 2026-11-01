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

function createTidyView(root) {
    const state = {
        query: '',
        /** @type {Set<string>} */
        selected: new Set(),
    };

    root.innerHTML = `
        <h3>프리셋 정리 <small>(Chat Completion)</small></h3>
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
        </div>`;

    const $ = (selector) => root.querySelector(selector);
    const tbody = $('tbody');
    const allBox = $('.preset-tidy-all');

    function visibleRows() {
        const query = state.query.trim().toLowerCase();
        return getPresetRows().filter(row => !query || row.name.toLowerCase().includes(query));
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
            : '<tr><td colspan="3" class="preset-tidy-empty">프리셋이 없습니다.</td></tr>';

        const count = selectable.filter(row => state.selected.has(row.name)).length;
        allBox.checked = selectable.length > 0 && count === selectable.length;
        allBox.indeterminate = count > 0 && count < selectable.length;
        allBox.disabled = selectable.length === 0;
        $('.preset-tidy-count').textContent = `${rows.length}개 중 ${count}개 선택`;
    }

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
    return { render, selectedNames };
}

async function openTidyWindow() {
    const { Popup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'preset-tidy';

    try {
        createTidyView(root);
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
