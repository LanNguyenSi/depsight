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

      // GitHub OAuth profile
      const githubProfile = profile as any;

      try {
        // Upsert user in database
        await prisma.user.upsert({
          where: { githubId: String(githubProfile.id) },
          update: {
            email: user.email || null,
            githubLogin: githubProfile.login,
            githubToken: account.access_token || '',
            avatarUrl: user.image || null,
            updatedAt: new Date(),
          },
          create: {
            githubId: String(githubProfile.id),
            email: user.email || null,
            githubLogin: githubProfile.login,
            githubToken: account.access_token || '',
            avatarUrl: user.image || null,
          },
        });

        return true;
      } catch (error) {
        console.error('Error saving user:', error);
        return false;
      }
    },
    async session({ session, token }) {
      if (session.user) {
        // Fetch user from database to get internal ID
        const dbUser = await prisma.user.findUnique({
          where: { githubId: String(token.sub) },
          select: { id: true, githubLogin: true, githubToken: true },
        });

        if (dbUser) {
          (session.user as any).id = dbUser.id;
          (session.user as any).githubLogin = dbUser.githubLogin;
          (session.user as any).githubToken = dbUser.githubToken;
        }
      }
      return session;
    },
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.sub = String((profile as any).id);
      }
      return token;
    },
  },
  pages: {
    signIn: '/login',
  },
});
