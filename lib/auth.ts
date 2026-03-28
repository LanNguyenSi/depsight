import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import { prisma } from './prisma';

function getProviders(): Provider[] {
  const providers: Provider[] = [];

  // GitHub OAuth — only when credentials are configured
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.push(
      GitHub({
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        authorization: {
          params: {
            scope: 'repo user:email read:org',
          },
        },
      }),
    );
  }

  // Dev credentials provider — development only
  if (process.env.NODE_ENV === 'development') {
    providers.push(
      Credentials({
        id: 'dev-login',
        name: 'Dev Login',
        credentials: {
          username: { label: 'Username', type: 'text' },
        },
        async authorize(credentials) {
          const username = (credentials?.username as string) || 'dev';
          const githubId = `dev-${username}`;

          const dbUser = await prisma.user.upsert({
            where: { githubId },
            update: { updatedAt: new Date() },
            create: {
              githubId,
              githubLogin: username,
              email: `${username}@localhost`,
              githubToken: 'dev-token',
              avatarUrl: null,
            },
          });

          return {
            id: githubId,
            name: dbUser.githubLogin,
            email: dbUser.email,
          };
        },
      }),
    );
  }

  return providers;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: getProviders(),
  callbacks: {
    async signIn({ user, account, profile }) {
      // Dev credentials — user is already upserted in authorize()
      if (account?.provider === 'dev-login') return true;

      if (!account || !profile) return false;

      const githubId = String(profile.id ?? profile.sub ?? '');
      const githubLogin = (profile as Record<string, unknown>).login as string | undefined;

      if (!githubId || !githubLogin) return false;

      try {
        await prisma.user.upsert({
          where: { githubId },
          update: {
            email: user.email ?? null,
            githubLogin,
            githubToken: account.access_token ?? '',
            avatarUrl: user.image ?? null,
            updatedAt: new Date(),
          },
          create: {
            githubId,
            email: user.email ?? null,
            githubLogin,
            githubToken: account.access_token ?? '',
            avatarUrl: user.image ?? null,
          },
        });
        return true;
      } catch (error) {
        console.error('Error saving user:', error);
        return false;
      }
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        const dbUser = await prisma.user.findUnique({
          where: { githubId: token.sub },
          select: { id: true, githubLogin: true, githubToken: true },
        });

        if (dbUser) {
          session.user.id = dbUser.id;
          session.user.githubLogin = dbUser.githubLogin;
          session.user.githubToken = dbUser.githubToken;
        }
      }
      return session;
    },
    async jwt({ token, account, profile }) {
      if (account?.provider === 'dev-login') {
        // For dev login, the user id is passed as credentials user id
        token.sub = account.providerAccountId;
      } else if (account && profile) {
        token.sub = String(profile.id ?? profile.sub ?? token.sub);
      }
      return token;
    },
  },
  pages: {
    signIn: '/login',
  },
});
