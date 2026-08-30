import { SignInButton, SignUpButton, UserButton } from '@clerk/react';

interface AuthDockProps {
  isLoaded: boolean;
  isSignedIn: boolean;
  displayName: string;
  onBeginSignIn?: () => void;
  onBeginSignUp?: () => void;
}

/**
 * Clerk auth controls. Rendered by main.tsx inside ClerkProvider and passed
 * to App/AppHeader as a slot; local mode renders no dock at all.
 */
export function AuthDock({
  isLoaded,
  isSignedIn,
  displayName,
  onBeginSignIn,
  onBeginSignUp,
}: AuthDockProps) {
  return (
    <div
      className="auth-dock"
      data-auth-state={!isLoaded ? 'loading' : isSignedIn ? 'signed-in' : 'signed-out'}
    >
      {!isLoaded ? (
        <span className="auth-dock__label">Loading...</span>
      ) : isSignedIn ? (
        <>
          <span className="auth-dock__label">{displayName}</span>
          <UserButton />
        </>
      ) : (
        <>
          <SignInButton mode="modal">
            <button type="button" className="auth-dock__button" onClick={onBeginSignIn}>
              Sign In
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button type="button" className="auth-dock__button is-primary" onClick={onBeginSignUp}>
              Join
            </button>
          </SignUpButton>
        </>
      )}
    </div>
  );
}
