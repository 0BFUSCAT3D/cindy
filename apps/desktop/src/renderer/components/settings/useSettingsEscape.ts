import { useEffect, type RefObject } from 'react';

import { isEditableKeyboardTarget, shouldCardShortcutYield } from '@/lib/editableKeyboardTarget';

/**
 * 设置页的 Esc 逐层返回（全平台同一套）。按键只在无人认领时才由设置页处理：
 * 搜索框清空、快捷键录制、弹窗 / 菜单 / 插件详情等内层先消费，输入法组字中的
 * Esc 只取消候选。焦点在设置页的输入框里时，第一下只离开输入框（等同点到别处，
 * 失焦即保存的字段照常提交），再按一次才交给 onEscape。
 *
 * 挂在 window 冒泡阶段，晚于 document 与组件层的处理者；同在 window 上的内层
 * （帮助面板）由调用方通过 enabled 让路。
 */
export function useSettingsEscape(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onEscape: () => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.keyCode === 229 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      const root = rootRef.current;
      const target = event.target;
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        isEditableKeyboardTarget(target) &&
        root?.contains(target)
      ) {
        event.preventDefault();
        target.blur();
        return;
      }
      if (shouldCardShortcutYield(event, 'dismiss', root)) return;
      // MorphPopover（模型选择器等）在 document capture 里关闭但不 preventDefault，
      // 面板会挂到收合动画结束；它在场时这一下 Esc 归它。
      if (document.querySelector('[data-morph-side]')) return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, onEscape, rootRef]);
}
