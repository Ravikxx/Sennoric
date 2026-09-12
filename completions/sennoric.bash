# Sennoric bash completion
# Source this file or add to ~/.bashrc:
#   source /path/to/axion/completions/axion.bash

_axion_complete() {
  local cur prev words
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local flags="--model --mode --link --doctor --update --version --help -m -M -v -h"
  local models="claude claude-opus claude-haiku fable gpt gpt-mini groq groq-fast mistral mistral-small gemini gemini-flash gemini-pro gemini-2.5-pro gemini-2.5-flash openrouter or ollama veil"
  local modes="ask plan auto bypass"

  case "$prev" in
    --model|-m) COMPREPLY=($(compgen -W "$models" -- "$cur")); return ;;
    --mode|-M)  COMPREPLY=($(compgen -W "$modes"  -- "$cur")); return ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  fi
}

complete -F _axion_complete axion
