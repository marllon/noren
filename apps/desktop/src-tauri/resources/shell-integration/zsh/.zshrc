# Noren shell integration for zsh: see .zshenv. Interactive shells.
#
# Loads the user's .zshrc, gives ZDOTDIR back to the user (zsh reads .zlogin and .zlogout from it
# and the programs started from this shell inherit it), then loads the integration.
# Keep this file ASCII only.

ZDOTDIR=${NOREN_USER_ZDOTDIR:-$HOME}
if [[ -r $ZDOTDIR/.zshrc ]]; then
    . $ZDOTDIR/.zshrc
fi
unset NOREN_USER_ZDOTDIR

# Back to what the user had: no ZDOTDIR at all when there was none.
if [[ $ZDOTDIR == "$HOME" ]]; then
    unset ZDOTDIR
else
    export ZDOTDIR
fi

if [[ -r $__noren_zdotdir/noren.zsh ]]; then
    . $__noren_zdotdir/noren.zsh
fi
unset __noren_zdotdir
