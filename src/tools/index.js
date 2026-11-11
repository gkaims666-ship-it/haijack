// Реестр инструментов и исполнитель с проверкой разрешений.

import { readFile, writeFile, editFile, listDir } from './files.js';
import { globTool, grepTool } from './search.js';
import { runCommand } from './command.js';
import { fetchUrl } from './web.js';
import { githubRead, githubWrite } from './github.js';
import { mcp } from '../mcp/client.js';

export const ALL_TOOLS = [readFile, listDir, globTool, grepTool, writeFile, editFile, runCommand, fetchUrl, githubRead, githubWrite];
const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export const TOOLSETS = {
  // fetch_url есть у всех: он ничего не меняет на диске, но всегда требует подтверждения
  architect: ['read_file', 'list_dir', 'glob', 'grep', 'fetch_url', 'github_read'],
  reviewer: ['read_file', 'list_dir', 'glob', 'grep', 'fetch_url', 'github_read'],
  coder: ['read_file', 'list_dir', 'glob', 'grep', 'write_file', 'edit_file', 'run_command', 'fetch_url', 'github_read', 'github_write'],
  executor: ['read_file', 'list_dir', 'glob', 'grep', 'run_command'],
  all: ALL_TOOLS.map((t) => t.name),
};

export function getTools(names) {
  return names.map((n) => byName.get(n)).filter(Boolean);
}

/**
 * Инструменты внешних серверов MCP для роли. Агентам, которые не меняют проект (Architect, Reviewer),
 * достаются только читающие; Executor внешними инструментами не пользуется.
 */
export function externalTools(role) {
  if (role === 'executor') return [];
  return mcp.tools({ readOnly: role === 'architect' || role === 'reviewer' });
}

/** Схемы для API */
export function toApiTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

/**
 * Выполняет один tool_use. Никогда не бросает — ошибки возвращаются модели как is_error,
 * чтобы агент мог исправиться сам.
 */
export async function executeTool(block, allowed, ctx) {
  const tool = allowed.find((t) => t.name === block.name);
  if (!tool) {
    return { content: `Инструмент ${block.name} недоступен этому агенту.`, isError: true };
  }
  const input = block.input || {};
  if (input.__parse_error) return { content: input.__parse_error, isError: true };

  if (!tool.readOnly) {
    const info = tool.describe ? tool.describe(input, ctx) : { title: tool.name, detail: '' };
    const ok = await ctx.approve({ tool: tool.name, ...info });
    if (!ok) {
      return {
        content: 'Пользователь отклонил это действие. Не повторяй его; предложи альтернативу или спроси, как продолжить.',
        isError: true,
      };
    }
  }
  try {
    const out = await tool.run(input, ctx);
    return { content: String(out ?? ''), isError: false };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const msg = err.code === 'ENOENT' ? `Файл или папка не найдены: ${input.path ?? ''}` : err.message;
    return { content: `Ошибка: ${msg}`, isError: true };
  }
}
