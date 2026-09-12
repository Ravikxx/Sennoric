#compdef sennoric
# Sennoric zsh completion
# Add to ~/.zshrc:
#   fpath=(/path/to/sennoric/completions $fpath)
#   autoload -Uz compinit && compinit
# Or source directly:
#   source /path/to/sennoric/completions/sennoric.zsh

_sennoric() {
  local -a models modes flags

  models=(
    'claude:Claude Sonnet (default)'
    'claude-opus:Claude Opus'
    'claude-haiku:Claude Haiku (fast)'
    'fable:Claude Fable 5'
    'gpt:GPT-4o'
    'gpt-mini:GPT-4o mini'
    'groq:Llama 3.3 70B via Groq'
    'groq-fast:Llama 3.1 8B via Groq'
    'mistral:Mistral Large'
    'mistral-small:Mistral Small'
    'gemini:Gemini 2.0 Flash'
    'gemini-flash:Gemini 2.0 Flash'
    'gemini-pro:Gemini 1.5 Pro'
    'gemini-2.5-pro:Gemini 2.5 Pro'
    'gemini-2.5-flash:Gemini 2.5 Flash'
    'openrouter:Llama 3.3 via OpenRouter'
    'or:OpenRouter alias'
    'ollama:Local Ollama (llama3)'
    'glyph:Glyph private model'
  )

  modes=(
    'ask:Ask mode — requires approval for actions'
    'plan:Plan mode — outputs a plan before acting'
    'auto:Auto (bypass) mode — runs without approval'
    'bypass:Alias for auto'
  )

  flags=(
    '(-m --model)'{-m,--model}'[model alias or raw ID]:model:->model'
    '(-M --mode)'{-M,--mode}'[mode: ask|plan|auto]:mode:->mode'
    '--link[link CLI to a running sennoric-serve web session]'
    '--doctor[check dependencies, API keys, and environment]'
    '--update[pull latest from GitHub and rebuild]'
    '(-v --version)'{-v,--version}'[print version and exit]'
    '(-h --help)'{-h,--help}'[show help]'
    '*:prompt:_default'
  )

  _arguments -s $flags

  case "$state" in
    model) _describe 'model' models ;;
    mode)  _describe 'mode'  modes  ;;
  esac
}

_sennoric "$@"
