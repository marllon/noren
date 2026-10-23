# Noren shell integration for bash (3.2 and newer; Git for Windows ships 5.x).
#
# Noren starts an interactive bash with `--rcfile` pointing here, because bash reads no other file
# when --rcfile is given and ignores --rcfile in a login shell. In a WSL distro (`wsl.exe -d ...`) a
# small launcher does it, for the login bash of the distro. So this file first loads what the
# user would have got without it, then adds the hooks:
#
#   NOREN_BASH_LOGIN set (the profile asked for --login): /etc/profile, then the first of
#       ~/.bash_profile, ~/.bash_login, ~/.profile
#   otherwise: /etc/bash.bashrc (when it exists), then ~/.bashrc
#
# The user's PS1 and PROMPT_COMMAND stay: PS1 is wrapped, PROMPT_COMMAND gets one function before
# and one after the user's commands. The script only writes escape sequences to the terminal; it
# changes no setting and runs nothing the user did not type.
#
#   OSC 7    ; file://host/path       the current folder (every prompt)
#   OSC 133  ; A / B                  the prompt starts / ends (inside PS1)
#   OSC 133  ; C                      the command starts running
#   OSC 133  ; D ; code               the command ended, with its exit code
#   OSC 633  ; E ; command line       the command line (backslash, ';' and control characters
#                                     are written as \\ and \xNN)
#
# C and E come from a DEBUG trap. When the user's own files already set a DEBUG trap (bash-preexec,
# some prompt frameworks), Noren leaves it alone and sends only 7, A and B.
#
# Keep this file ASCII only with LF line ends.

__noren_login=${NOREN_BASH_LOGIN-}
unset NOREN_BASH_LOGIN

if [ -n "$__noren_login" ]; then
    [ -r /etc/profile ] && . /etc/profile
    if [ -r "$HOME/.bash_profile" ]; then
        . "$HOME/.bash_profile"
    elif [ -r "$HOME/.bash_login" ]; then
        . "$HOME/.bash_login"
    elif [ -r "$HOME/.profile" ]; then
        . "$HOME/.profile"
    fi
else
    [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
    [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi
unset __noren_login

[ -n "${BASH_VERSION-}" ] || return 0
case $- in *i*) ;; *) return 0 ;; esac
[ -z "${__noren_loaded-}" ] || return 0
__noren_loaded=1

# State: a command is running (D is due at the next prompt); the prompt is shown and the next
# command is the first one of a new line (C and E are due); the value of HISTCMD at that prompt
# (the number the next line gets when the history keeps it); the folder last turned into a URI,
# and that URI.
__noren_running=
__noren_ready=
__noren_armed=
__noren_cwd=
__noren_uri=

# Longest command line sent in OSC 633;E. The terminal side drops a sequence over 8 KiB.
__noren_max_line=2000

# Sets REPLY to $1 as OSC 633;E wants it.
__noren_escape() {
    local s=$1 bs='\'
    s=${s:0:$__noren_max_line}
    s=${s//"$bs"/"$bs$bs"}
    s=${s//;/"${bs}x3b"}
    s=${s//$'\n'/"${bs}x0a"}
    s=${s//$'\r'/"${bs}x0d"}
    s=${s//$'\t'/"${bs}x09"}
    s=${s//$'\033'/"${bs}x1b"}
    s=${s//$'\177'/"${bs}x7f"}
    s=${s//[[:cntrl:]]/}
    REPLY=$s
}

# Sets REPLY to the folder $1 of a WSL distro as Windows names it, in the form the path of a file
# URI takes: "/C:/Users/me" for a folder on a drive (/mnt/c/Users/me), "//wsl.localhost/<distro>/home/me"
# for the files of the distro. Windows opens both, so the branch, the project files and the tab of a
# folder in the distro are read from the Windows side like any other folder. `wslpath` knows how the
# drives are mounted in this distro; without it only the default /mnt/<letter> is told apart.
__noren_wsl_folder() {
    local w
    if type wslpath > /dev/null 2>&1 && w=$(wslpath -m -- "$1" 2> /dev/null) && [ -n "$w" ]; then
        case $w in
            [a-zA-Z]:*) REPLY=/$w ;;
            //*) REPLY=$w ;;
            *) REPLY=//wsl.localhost/$WSL_DISTRO_NAME$1 ;;
        esac
    elif [[ $1 =~ ^/mnt/([a-zA-Z])(/.*)?$ ]]; then
        w=${BASH_REMATCH[1]}
        REPLY=/${w^}:${BASH_REMATCH[2]:-/}
    else
        REPLY=//wsl.localhost/$WSL_DISTRO_NAME$1
    fi
}

# Sets REPLY to the file URI of the current folder: "file://host/C:/Users/me" for a Windows
# folder, "file://host/home/me" elsewhere (in WSL, the Windows name of the folder, see above), with
# everything but letters, digits and "/._~:-" written as %XX.
__noren_make_uri() {
    local dir=$PWD host=${HOSTNAME:-localhost} out= c hex i LC_ALL=C
    case ${OSTYPE-} in
        linux*)
            if [ -n "${WSL_DISTRO_NAME-}" ]; then
                __noren_wsl_folder "$dir"
                dir=$REPLY
            fi
            ;;
        msys* | cygwin*)
            if [[ $dir =~ ^/([a-zA-Z])(/.*)?$ ]]; then
                dir=/${BASH_REMATCH[1]^}:${BASH_REMATCH[2]:-/}
            elif type cygpath > /dev/null 2>&1; then
                dir=$(cygpath -m "$dir" 2> /dev/null) || dir=$PWD
                if [[ $dir == //* ]]; then
                    out=${dir#//}
                    host=${out%%/*}
                    dir=/${out#*/}
                    out=
                elif [[ $dir == [a-zA-Z]:* ]]; then
                    dir=/$dir
                fi
            fi
            ;;
    esac
    if [[ $dir == *[!a-zA-Z0-9/._~:-]* ]]; then
        for ((i = 0; i < ${#dir}; i++)); do
            c=${dir:i:1}
            case $c in
                [a-zA-Z0-9/._~:-]) out+=$c ;;
                *)
                    printf -v hex '%%%02X' "'$c"
                    out+=$hex
                    ;;
            esac
        done
    else
        out=$dir
    fi
    REPLY=file://$host$out
}

# Writes OSC 633;E with the last line of the history.
__noren_send_line() {
    local line
    line=$(HISTTIMEFORMAT= builtin history 1 2> /dev/null)
    line=${line#"${line%%[![:space:]]*}"}
    line=${line#"${line%%[!0-9]*}"}
    line=${line#"${line%%[![:space:]]*}"}
    if [ -n "$line" ]; then
        __noren_escape "$line"
        printf '\033]633;E;%s\007' "$REPLY"
    fi
}

# First in PROMPT_COMMAND: the exit status of the last command is still in $?.
__noren_precmd() {
    local s=$?
    if [ -n "$__noren_ready" ]; then
        __noren_ready=
        # The prompt was shown and no command made the DEBUG trap start one. Either the line was
        # empty, or it began with something the trap does not see, such as a subshell `(exit 3)`.
        # The history tells them apart: only a line it kept moved HISTCMD. That command already
        # ran, so C comes now, together with D.
        if [ "$HISTCMD" != "$__noren_armed" ]; then
            __noren_send_line
            printf '\033]133;C\007'
            __noren_running=1
        fi
    fi
    if [ -n "$__noren_running" ]; then
        __noren_running=
        printf '\033]133;D;%s\007' "$s"
    fi
    if [ "$PWD" != "$__noren_cwd" ]; then
        __noren_cwd=$PWD
        __noren_make_uri
        __noren_uri=$REPLY
    fi
    printf '\033]7;%s\007' "$__noren_uri"
    return "$s"
}

# Last in PROMPT_COMMAND: wraps whatever PS1 is by now (the user's, or one a prompt command of the
# user just rebuilt) once, and arms the DEBUG trap for the next command line.
__noren_ps1() {
    local s=$?
    case $PS1 in
        *'\[\033]133;A\a\]'*) ;;
        *) PS1='\[\033]133;A\a\]'"$PS1"'\[\033]133;B\a\]' ;;
    esac
    __noren_armed=$HISTCMD
    __noren_ready=1
    return "$s"
}

# DEBUG trap: runs before every simple command, but only the first one of a line is of interest.
# $1 is the `$_` of the command before, which this function gives back; $2 is the command about to
# run. __noren_precmd is the prompt command starting: it decides by itself what the line before
# was, so the trap leaves it alone.
__noren_debug() {
    if [ "$2" != __noren_precmd ] && [ -n "$__noren_ready" ] && [ "${#FUNCNAME[@]}" -le 1 ]; then
        __noren_ready=
        # A line the history did not keep (ignorespace, ignoredups) leaves HISTCMD at the number
        # of the entry before it, so `history 1` is not this line and there is no E for it.
        if [ "$HISTCMD" = "$__noren_armed" ]; then
            __noren_send_line
        fi
        __noren_running=1
        printf '\033]133;C\007'
    fi
    : "$1"
}

# PROMPT_COMMAND: a plain string, or an array in bash 5.1 and newer. New lines (not ';') join the
# commands, so a comment at the end of the user's text cannot swallow ours.
case $(declare -p PROMPT_COMMAND 2> /dev/null) in
    "declare -a"*)
        PROMPT_COMMAND=(__noren_precmd "${PROMPT_COMMAND[@]}" __noren_ps1)
        ;;
    *)
        PROMPT_COMMAND="__noren_precmd"$'\n'"${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__noren_ps1"
        ;;
esac

if [ -z "$(trap -p DEBUG)" ]; then
    trap '__noren_debug "$_" "$BASH_COMMAND"' DEBUG
fi
