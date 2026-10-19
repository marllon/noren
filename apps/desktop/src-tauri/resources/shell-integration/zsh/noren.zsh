# Noren shell integration for zsh, loaded by .zshrc in this folder AFTER the user's own .zshrc.
#
# The user's prompt and hooks stay: PROMPT is wrapped, and the hooks are added to precmd_functions
# and preexec_functions. The script only writes escape sequences to the terminal; it changes no
# setting and runs nothing the user did not type.
#
#   OSC 7    ; file://host/path       the current folder (every prompt)
#   OSC 133  ; A / B                  the prompt starts / ends (inside PROMPT)
#   OSC 133  ; C                      the command starts running
#   OSC 133  ; D ; code               the command ended, with its exit code
#   OSC 633  ; E ; command line       the command line (backslash, ';' and control characters
#                                     are written as \\ and \xNN)
#
# Every function starts with `emulate -L zsh`, so the options the user set (KSH_ARRAYS, ...) do
# not change how this script reads its own text.
#
# Keep this file ASCII only.

[[ -o interactive ]] || return 0
(( ${+__noren_loaded} )) && return 0
typeset -g __noren_loaded=1

autoload -Uz add-zsh-hook

# A command is running (D is due at the next prompt).
typeset -g __noren_running=

# Longest command line sent in OSC 633;E. The terminal side drops a sequence over 8 KiB.
typeset -g __noren_max_line=2000

# Sets REPLY to $1 as OSC 633;E wants it.
__noren_escape() {
    emulate -L zsh
    local s=${1[1,$__noren_max_line]} out= c hex i
    if [[ $s == *\\* || $s == *\;* || $s == *[[:cntrl:]]* ]]; then
        for ((i = 1; i <= ${#s}; i++)); do
            c=${s[i]}
            if [[ $c == '\' ]]; then
                out+='\\'
            elif [[ $c == ';' || $c == [[:cntrl:]] ]]; then
                hex=$(( [##16] #c ))
                out+='\x'${(l:2::0:)hex}
            else
                out+=$c
            fi
        done
        s=$out
    fi
    REPLY=$s
}

# Sets REPLY to the file URI of the current folder, with everything but letters, digits and
# "/._~:-" written as %XX (one per byte).
__noren_make_uri() {
    emulate -L zsh
    local dir=$PWD out= c hex i LC_ALL=C
    if [[ $dir == *[^a-zA-Z0-9/._~:-]* ]]; then
        for ((i = 1; i <= ${#dir}; i++)); do
            c=${dir[i]}
            if [[ $c == [a-zA-Z0-9/._~:-] ]]; then
                out+=$c
            else
                hex=$(( [##16] #c ))
                out+='%'${(l:2::0:)hex}
            fi
        done
    else
        out=$dir
    fi
    REPLY=file://${HOST:-localhost}$out
}

# First of the precmd hooks: the exit status of the last command is still in $?.
__noren_precmd() {
    local s=$?
    emulate -L zsh
    if [[ -n $__noren_running ]]; then
        __noren_running=
        printf '\033]133;D;%s\007' "$s"
    fi
    __noren_make_uri
    printf '\033]7;%s\007' "$REPLY"
    return $s
}

# Last of the precmd hooks: wraps whatever PROMPT is by now (the user's, or one a hook of the user
# just rebuilt) once. %{ %} marks text that takes no room on the line.
__noren_prompt() {
    local s=$?
    emulate -L zsh
    local mark_a=$'%{\033]133;A\007%}' mark_b=$'%{\033]133;B\007%}'
    if [[ $PROMPT != *"$mark_a"* ]]; then
        PROMPT=$mark_a$PROMPT$mark_b
    fi
    return $s
}

# Runs once the line is accepted, before the command. $1 is the line as it was typed.
__noren_preexec() {
    emulate -L zsh
    __noren_escape "$1"
    printf '\033]633;E;%s\007\033]133;C\007' "$REPLY"
    __noren_running=1
}

precmd_functions=(__noren_precmd ${precmd_functions:#__noren_precmd})
precmd_functions=(${precmd_functions:#__noren_prompt} __noren_prompt)
add-zsh-hook preexec __noren_preexec
