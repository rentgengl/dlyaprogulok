# Документация Spec Kit для Rasskazhi

Архив содержит документы для размещения в корне репозитория `Rasskazhi`.

## Состав

- `.specify/memory/constitution.md` — проектные принципы.
- `specs/001-baseline-project/spec.md` — baseline функциональной спецификации.
- `specs/001-baseline-project/plan.md` — архитектурный план.
- `specs/001-baseline-project/tasks.md` — задачи проверки и развития.
- `research.md`, `data-model.md`, `quickstart.md` — вспомогательные документы.
- `contracts/` — инвентаризация API, БД и внешних интеграций.
- `checklists/requirements.md` — reviewer-owned checklist.

## Установка в репозиторий

Распакуйте содержимое архива в корень репозитория `Rasskazhi`, сохраняя структуру каталогов. Архив не содержит исходный код приложения, базу данных, `.env`, `node_modules`, `dist` или пользовательские загрузки.

## Важно: сначала инициализировать Spec Kit

Эти документы не заменяют установку CLI и интеграцию Spec Kit с вашим coding agent. В существующем репозитории следуйте актуальному руководству Spec Kit по adoption существующего проекта:
https://github.com/github/spec-kit/blob/main/docs/guides/existing-projects.md

После установки и инициализации проверьте, что:
- `.specify/memory/constitution.md` сохранён и не перезаписан шаблоном;
- выбранная интеграция распознаёт команды `/speckit-*`;
- active feature directory указывает на `specs/001-baseline-project` (Spec Kit использует `.specify/feature.json` либо `SPECIFY_FEATURE_DIRECTORY`, в зависимости от версии/настройки);
- шаблоны Spec Kit не перезаписали документы.

## Рекомендуемый порядок

1. Откройте `constitution.md`, проверьте и утвердите принципы.
2. Запустите `/speckit-constitution` с указанием, что нужно синхронизировать и сохранить принципы проекта; проверьте результат.
3. Используйте `spec.md` как baseline и попросите `/speckit-specify` проверить/уточнить его, а не генерировать продукт заново.
4. Запустите `/speckit-plan` с инструкцией документировать существующую архитектуру, не заменяя стек.
5. Проверьте `tasks.md`, затем `/speckit-tasks` и `/speckit-analyze`.
6. Только после ревью задач запускайте `/speckit-implement` небольшими порциями.
7. После реализации запускайте `/speckit-converge`; повторяйте implement/converge до Converged.

## Предупреждения

- Не запускайте `/speckit-implement` сразу после распаковки: сначала проверьте задачи и текущую ветку.
- В документах намеренно помечены вопросы и расхождения, требующие подтверждения.
- README исходного проекта содержит утверждения о password reset и account deletion, которые расходятся с обработчиками и тестами в архиве. См. `research.md`.
- В исходном архиве обнаружены runtime-файлы `.env`, SQLite и пользовательские uploads. Они не включены в этот архив документации.
- Документы подготовлены по snapshot архива; при использовании на более новой ветке нужно повторно сверить их с кодом.

## Ссылки

- Spec Kit: https://github.com/github/spec-kit
- Quickstart: https://github.com/github/spec-kit/blob/main/docs/quickstart.md
- Existing projects: https://github.com/github/spec-kit/blob/main/docs/guides/existing-projects.md
