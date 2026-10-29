# CLAUDE.md

## Codex(GPT) 조수에게 묻기

Codex 의견이 필요하면 터미널(Bash)에서 이렇게 물어볼 것:

```bash
codex exec --sandbox read-only "질문" < /dev/null
```

- `< /dev/null`은 꼭 붙일 것. 없으면 Codex가 추가 입력을 기다리며 멈춘다.
- `--sandbox read-only`라서 Codex는 파일을 읽기만 하고 수정하지 않는다. 수정은 Claude가 한다.
- easy-codex MCP 도구는 같은 이유(stdin을 닫지 않음)로 멈추므로 쓰지 말 것.
