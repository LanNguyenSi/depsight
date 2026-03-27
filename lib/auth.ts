import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { prisma } from './prisma';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: 'repo user:email read:org',
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!account || !profile) return false;

      // GitHub profile has `login` and numeric `id` (returned as string by next-auth)
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
      if (account && profile) {
        token.sub = String(profile.id ?? profile.sub ?? token.sub);
      }
      return token;
    },
  },
  pages: {
    signIn: '/login',
  },
});
