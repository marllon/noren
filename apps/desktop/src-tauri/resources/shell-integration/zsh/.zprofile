# Noren shell integration for zsh: see .zshenv. Login shells only.
# Keep this file ASCII only.

ZDOTDIR=${NOREN_USER_ZDOTDIR:-$HOME}
if [[ -r $ZDOTDIR/.zprofile ]]; then
    . $ZDOTDIR/.zprofile
fi
if [[ $ZDOTDIR == "$HOME" ]]; then
    NOREN_USER_ZDOTDIR=
else
    NOREN_USER_ZDOTDIR=$ZDOTDIR
fi
ZDOTDIR=$__noren_zdotdir
