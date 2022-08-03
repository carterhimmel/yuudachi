import { Buffer } from 'node:buffer';
import dayjs from 'dayjs';
import { ButtonStyle, Collection, ComponentType, type GuildMember, hyperlink, time, TimestampStyles } from 'discord.js';
import i18next from 'i18next';
import { nanoid } from 'nanoid';
import type { ArgsParam, InteractionParam, LocaleParam } from '../../../../Command.js';
import { DATE_FORMAT_LOGFILE } from '../../../../Constants.js';
import { blastOff } from '../../../../functions/anti-raid/blastOff.js';
import { formatMemberTimestamps } from '../../../../functions/anti-raid/formatMemberTimestamps.js';
import { parseFile } from '../../../../functions/anti-raid/parseFile.js';
import { insertAntiRaidNukeCaseLog } from '../../../../functions/logging/insertAntiRaidNukeCaseLog.js';
import { upsertAntiRaidNukeReport } from '../../../../functions/logging/upsertGeneralLog.js';
import type { AntiRaidNukeCommand } from '../../../../interactions/index.js';
import { logger } from '../../../../logger.js';
import { createButton } from '../../../../util/button.js';
import { createMessageActionRow } from '../../../../util/messageActionRow.js';

export async function file(
	interaction: InteractionParam,
	args: ArgsParam<typeof AntiRaidNukeCommand>['file'],
	locale: LocaleParam,
): Promise<void> {
	const reply = await interaction.deferReply({ ephemeral: args.hide ?? true });
	const ids = await parseFile(args.file);

	if (!ids.size) {
		throw new Error(i18next.t('command.mod.anti_raid_nuke.file.errors.no_ids', { lng: locale }));
	}

	const fetchedMembers = await interaction.guild.members.fetch({ force: true });
	const members = new Collection<string, GuildMember>();
	const fails = new Set<string>();

	for (const id of ids) {
		const member = fetchedMembers.get(id);

		if (member) {
			members.set(id, member);
		} else {
			fails.add(id);
		}
	}

	if (!members.size) {
		throw new Error(i18next.t('command.mod.anti_raid_nuke.file.errors.no_hits', { lng: locale }));
	}

	const parameterStrings = [
		i18next.t('command.mod.anti_raid_nuke.common.parameters.heading', { lng: locale }),
		i18next.t('command.mod.anti_raid_nuke.common.parameters.current_time', {
			now: time(dayjs().unix(), TimestampStyles.ShortDateTime),
			lng: locale,
		}),
		i18next.t('command.mod.anti_raid_nuke.file.parameters.file', {
			file: hyperlink('File uploaded', args.file.url),
			lng: locale,
		}),
		i18next.t('command.mod.anti_raid_nuke.common.parameters.days', {
			count: Math.min(Math.max(Number(args.days ?? 1), 0), 7),
			lng: locale,
		}),
	];

	if (fails.size) {
		parameterStrings.push(
			i18next.t('command.mod.anti_raid_nuke.file.parameters.users', {
				count: fails.size,
				lng: locale,
			}),
		);
	}

	const banKey = nanoid();
	const cancelKey = nanoid();
	const dryRunKey = nanoid();

	const banButton = createButton({
		customId: banKey,
		label: i18next.t('command.mod.anti_raid_nuke.common.buttons.execute', { lng: locale }),
		style: ButtonStyle.Danger,
	});
	const cancelButton = createButton({
		customId: cancelKey,
		label: i18next.t('command.common.buttons.cancel', { lng: locale }),
		style: ButtonStyle.Secondary,
	});
	const dryRunButton = createButton({
		customId: dryRunKey,
		label: i18next.t('command.mod.anti_raid_nuke.common.buttons.dry_run', { lng: locale }),
		style: ButtonStyle.Primary,
	});

	const potentialHits = Buffer.from(members.map((member) => `${member.user.tag} (${member.id})`).join('\n'));
	const potentialHitsDate = dayjs().format(DATE_FORMAT_LOGFILE);

	const { creationRange, joinRange } = formatMemberTimestamps(members);

	await interaction.editReply({
		content: `${i18next.t('command.mod.anti_raid_nuke.common.pending', {
			count: members.size,
			creation_range: creationRange,
			join_range: joinRange,
			lng: locale,
		})}\n\n${parameterStrings.join('\n')}`,
		files: [{ name: `${potentialHitsDate}-anti-raid-nuke-list.txt`, attachment: potentialHits }],
		components: [createMessageActionRow([cancelButton, banButton, dryRunButton])],
	});

	const collectedInteraction = await reply
		.awaitMessageComponent({
			filter: (collected) => collected.user.id === interaction.user.id,
			componentType: ComponentType.Button,
			time: 60000,
		})
		.catch(async () => {
			try {
				await interaction.editReply({
					content: i18next.t('command.common.errors.timed_out', { lng: locale }),
					components: [],
				});
			} catch (e) {
				const error = e as Error;
				logger.error(error, error.message);
			}
			return undefined;
		});

	if (collectedInteraction?.customId === cancelKey) {
		await collectedInteraction.update({
			content: i18next.t('command.mod.anti_raid_nuke.common.cancel', {
				lng: locale,
			}),
			components: [],
		});
	} else if (collectedInteraction?.customId === banKey || collectedInteraction?.customId === dryRunKey) {
		const dryRunMode = collectedInteraction.customId === dryRunKey;

		const content =
			collectedInteraction.message.content +
			(dryRunMode ? `\n\n${i18next.t('command.mod.anti_raid_nuke.common.parameters.dry_run', { lng: locale })}` : '');

		await collectedInteraction.update({
			content,
			components: [
				createMessageActionRow([
					{ ...cancelButton, disabled: true },
					{ ...banButton, disabled: true },
				]),
			],
		});

		const { result, cases } = await blastOff(
			collectedInteraction,
			{
				days: Math.min(Math.max(Number(args.days ?? 1), 0), 7),
				dryRun: dryRunMode,
			},
			members,
			locale,
		);

		if (!dryRunMode && cases.length) {
			await insertAntiRaidNukeCaseLog(
				collectedInteraction.guild,
				collectedInteraction.user,
				cases,
				args.reason ??
					i18next.t('command.mod.anti_raid_nuke.common.success', {
						count: result.filter((r) => r.success).length,
						lng: locale,
					}),
			);
		}

		const membersHit = Buffer.from(
			result
				.map((r) =>
					i18next.t('command.mod.anti_raid_nuke.common.attachment', {
						user_id: r.member.user.id.padEnd(19, ' '),
						joined_at: dayjs(r.member.joinedTimestamp).format(DATE_FORMAT_LOGFILE),
						created_at: dayjs(r.member.user.createdTimestamp).format(DATE_FORMAT_LOGFILE),
						user_tag: r.member.user.tag,
						lng: locale,
					}),
				)
				.join('\n'),
		);
		const membersHitDate = dayjs().format(DATE_FORMAT_LOGFILE);

		await upsertAntiRaidNukeReport(collectedInteraction.guild, collectedInteraction.user, result);

		await collectedInteraction.editReply({
			content: i18next.t('command.mod.anti_raid_nuke.common.success', {
				count: result.filter((r) => r.success).length,
				lng: locale,
			}),
			files: [{ name: `${membersHitDate}-anti-raid-nuke-hits.txt`, attachment: membersHit }],
			components: [],
		});
	}
}
