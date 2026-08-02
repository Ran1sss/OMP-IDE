const TASK_IMPERATIVE_RE = /^(добавь|сделай|исправь|поправь|почини|создай|удали|убери|напиши|проверь|протестируй|запусти|перезапусти|переименуй|обнови|замени|отрефактори|разверни|задеплой|подними|установи|настрой|add|fix|make|create|implement|write|check|test|run|update|refactor|rename|delete|remove|deploy|build|change|setup|set|install|configure)(?=\s|$|[.!?;,:])/i;

export function isTaskImperative(text: string): boolean {
  return TASK_IMPERATIVE_RE.test(text.trim());
}
