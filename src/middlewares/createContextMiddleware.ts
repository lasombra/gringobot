import { Alpha2Code } from 'i18n-iso-countries';
import { Middleware } from 'telegraf';
import { runMessageRecycling } from '../autoDeleteMessages';
import { CommandDescriptions } from '../command';
import { Config } from '../config';
import { BotContext } from '../context';
import { createDatabase } from '../database';
import { withRejected, withFulfilled } from '../extensions/promises';
import { createMemberMention } from '../member';

interface Props {
  config: Config;
}

type MessageDeletionIntervals = Record<string, NodeJS.Timeout>;

/**
 * Message Deletion Intervals
 *
 * This object is mutated during runtime to include
 * interval instances for message auto deletion for
 * each chat being used.
 *
 * The key of this object will always be the chat id,
 * and the value will be an instance of NodeJS.Timeout.
 */
const messageDeletionIntervals: MessageDeletionIntervals = {};

export const createContextMiddleware = ({ config }: Props) => {
  const middleware: Middleware<BotContext> = async (ctx, next) => {
    const chatId = ctx?.chat?.id;

    if (!chatId) {
      ctx.logger.error(
        'Chat ID is missing from event. This event is not repliable.'
      );
      console.log(ctx);
      return;
    }

    if (!ctx.from) {
      ctx.logger.error(
        'User is missing from event. This event is not repliable.'
      );
      console.log(ctx);
      return;
    }

    if (config.chatsWithForcedPortuguese.includes(chatId)) {
      /**
       * telegraf-i18n uses the user session to determine
       * which locale to use. This basically forces
       * all answers to be sent in ptbr.
       **/
      ctx.i18n.locale('ptbr');
    }

    const logger = ctx.logger.child({ source: 'database' });

    const loadDatabase = () => {
      return createDatabase(chatId, config.dataPath, logger);
    };

    const replyWithAutoDestructiveMessage: BotContext['replyWithAutoDestructiveMessage'] = async (
      markdownMessage,
      options = {
        deleteReplyMessage: true,
        deleteCommandMessage: true,
      }
    ) => {
      const messageSent = await ctx.replyWithMarkdown(
        markdownMessage
      );

      if (!config.messageTimeoutEnabled) {
        return messageSent;
      }

      if (options.deleteCommandMessage && ctx.message?.message_id) {
        await ctx.database.addAutoDeleteMessage(
          ctx.message?.message_id
        );
      }

      if (options.deleteReplyMessage) {
        await ctx.database.addAutoDeleteMessage(
          messageSent.message_id
        );
      }

      return messageSent;
    };

    const fetchMembersMentionList = async (
      countryCode: Alpha2Code,
      silenced: boolean = false
    ) => {
      const memberIds = ctx.database.getMembersAt(countryCode);
      const membersFetchResult = await Promise.allSettled(
        memberIds.map(async (userId) => {
          return fetchMemberMention(userId, silenced);
        })
      );

      withRejected(membersFetchResult).forEach(({ reason }) => {
        ctx.logger.warn(reason);
      });

      const members = withFulfilled(membersFetchResult).map(
        ({ value }) => value
      );

      return members;
    };

    const fetchRemoteMembersMentionList = async (
      silenced: boolean = false
    ) => {
      const allMembers = ctx.database.getAllRemoteMembers();

      const membersFetchResult = await Promise.allSettled(
        Object.keys(allMembers).map(async (userId) => {
          return fetchMemberMention(parseInt(userId), silenced);
        })
      );

      withRejected(membersFetchResult).forEach(({ reason }) => {
        ctx.logger.warn(reason);
      });

      const members = withFulfilled(membersFetchResult).map(
        ({ value }) => value
      );
      return members;
    };

    const fetchMemberMention = async (
      userId: number,
      silenced: boolean
    ) => {
      try {
        const member = await ctx.getChatMember(Number(userId));
        return createMemberMention(member.user, silenced);
      } catch (err: any) {
        if (
          err.code === 400 &&
          err.message.includes('user not found')
        ) {
          ctx.logger.warn(
            `Registered user with id "${userId}" does not exist. Removing user remote.`
          );
          ctx.database.removeRemoteMember(Number(userId));
        }
        throw err;
      }
    };

    ctx.fetchMembersMentionList = fetchMembersMentionList;
    ctx.fetchRemoteMembersMentionList = fetchRemoteMembersMentionList;
    ctx.replyWithAutoDestructiveMessage = replyWithAutoDestructiveMessage;
    ctx.loadDatabase = loadDatabase;
    ctx.database = await loadDatabase();
    ctx.config = config;
    ctx.safeUser = {
      id: ctx.from.id,
      mention: createMemberMention(ctx.from),
    };

    ctx.setMyCommands(CommandDescriptions);

    if (config.messageTimeoutEnabled) {
      const chatMessageRecyclingInterval =
        messageDeletionIntervals[chatId];

      if (!chatMessageRecyclingInterval) {
        ctx.logger.info(
          `Creating message deletion interval for chat "${chatId}".`
        );

        messageDeletionIntervals[chatId] = setInterval(() => {
          runMessageRecycling(ctx);
        }, 10000);

        process.on('SIGINT', () =>
          clearInterval(messageDeletionIntervals[chatId])
        );
      }
    }

    return next();
  };

  return middleware;
};
