# Noren shell integration for zsh: Noren starts zsh with ZDOTDIR pointing at this folder, so zsh
# reads these files instead of the user's. Each one loads the user's own file from the folder the
# user's setup uses (NOREN_USER_ZDOTDIR, which is empty when the user has no ZDOTDIR and zsh reads
# $HOME), with ZDOTDIR set to that folder while it runs. Noren's own value comes back afterwards so
# zsh finds the next file here. .zshrc, the last file that matters, gives the user's value back for
# good. Keep this file ASCII only.

typeset -g __noren_zdotdir=$ZDOTDIR
ZDOTDIR=${NOREN_USER_ZDOTDIR:-$HOME}
if [[ -r $ZDOTDIR/.zshenv ]]; then
    . $ZDOTDIR/.zshenv
fi
# The user's file may have set its own ZDOTDIR; the home folder is the same as none.
if [[ $ZDOTDIR == "$HOME" ]]; then
    NOREN_USER_ZDOTDIR=
else
    NOREN_USER_ZDOTDIR=$ZDOTDIR
fi
ZDOTDIR=$__noren_zdotdir
