import { Component, HostBinding, HostListener, Input } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import deepClone from 'clone-deep'
import FuzzySearch from 'fuzzy-search'

import { ConfigService } from '../services/config.service'
import { ProfilesService } from '../services/profiles.service'
import { AppService } from '../services/app.service'
import { SelectorService } from '../services/selector.service'
import { NotificationsService } from '../services/notifications.service'
import { PlatformService } from '../api/platform'
import { ProfileProvider } from '../api/index'
import { PartialProfileGroup, ProfileGroup, PartialProfile, Profile } from '../index'
import { BaseComponent } from './base.component'

interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

/** @hidden */
@Component({
    selector: 'profile-tree',
    styleUrls: ['./profileTree.component.scss'],
    templateUrl: './profileTree.component.pug',
})
export class ProfileTreeComponent extends BaseComponent {
    profileGroups: PartialProfileGroup<ProfileGroup>[] = []
    rootGroups: PartialProfileGroup<ProfileGroup>[] = []

    filteredProfiles: PartialProfile<Profile>[] = []
    @Input() filter = ''


    panelMinWidth = 200
    panelMaxWidth = 600
    panelInternalWidth: number = parseInt(window.localStorage.profileTreeWidth ?? '300')
    panelStartWidth = this.panelInternalWidth
    panelIsResizing = false
    panelStartX = 0

    constructor (
        private app: AppService,
        private platform: PlatformService,
        private config: ConfigService,
        private profilesService: ProfilesService,
        private translate: TranslateService,
        private ngbModal: NgbModal,
        private selector: SelectorService,
        private notifications: NotificationsService,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        await this.loadTreeItems()
        this.subscribeUntilDestroyed(this.config.changed$, () => this.loadTreeItems())
        this.app.tabsChanged$.subscribe(() => this.tabStateChanged())
        this.app.activeTabChange$.subscribe(() => this.tabStateChanged())
    }


    private async loadTreeItems (): Promise<void> {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        let groups = await this.profilesService.getProfileGroups({ includeNonUserGroup: true, includeProfiles: true })

        for (const group of groups) {
            if (group.profiles?.length) {
                // remove template profiles
                group.profiles = group.profiles.filter(x => !x.isTemplate)

                // remove blocklisted profiles
                group.profiles = group.profiles.filter(x => x.id && !this.config.store.profileBlacklist.includes(x.id))
            }
        }

        if (!this.config.store.terminal.showBuiltinProfiles) { groups = groups.filter(g => g.id !== 'built-in') }

        groups.sort((a, b) => a.name.localeCompare(b.name))
        groups.sort((a, b) => (a.id === 'built-in' || !a.editable ? 1 : 0) - (b.id === 'built-in' || !b.editable ? 1 : 0))
        groups.sort((a, b) => (a.id === 'ungrouped' ? 0 : 1) - (b.id === 'ungrouped' ? 0 : 1))
        this.profileGroups = groups.map(g => ProfileTreeComponent.intoPartialCollapsableProfileGroup(g, profileGroupCollapsed[g.id] ?? false))
        this.rootGroups = this.buildRootGroups()
    }

    private buildRootGroups (): PartialProfileGroup<ProfileGroup>[] {
        const rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
        const favoriteIds = this.config.store.profileFavorites
        const favorites = this.profileGroups
            .flatMap(g => g.profiles ?? [])
            .filter(p => p.id && favoriteIds.includes(p.id))
        if (!favorites.length) {
            return rootGroups
        }
        const collapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        return [
            ProfileTreeComponent.intoPartialCollapsableProfileGroup({
                id: 'favorites',
                editable: false,
                name: this.translate.instant('Favorites'),
                icon: 'fas fa-star',
                profiles: favorites,
            }, collapsed.favorites ?? false),
            ...rootGroups,
        ]
    }

    isFavorite (profile: PartialProfile<Profile>): boolean {
        return !!profile.id && this.config.store.profileFavorites.includes(profile.id)
    }

    async toggleFavorite (profile: PartialProfile<Profile>): Promise<void> {
        if (!profile.id) { return }
        const favorites: string[] = this.config.store.profileFavorites
        this.config.store.profileFavorites = this.isFavorite(profile)
            ? favorites.filter(x => x !== profile.id)
            : [...favorites, profile.id]
        await this.config.save()
    }

    private async showProfileEditModal (profile: PartialProfile<Profile>): Promise<PartialProfile<Profile>|null> {
        const { EditProfileModalComponent } = window['nodeRequire']('tabby-settings')
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )

        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) { throw new Error('Cannot edit a profile without a provider') }

        modal.componentInstance.partialProfile = deepClone({ ...profile })
        modal.componentInstance.profileProvider = provider

        const result = await modal.result.catch(() => null)
        if (!result) { return null }

        result.type = provider.id
        return result
    }

    private async editProfile (profile: PartialProfile<Profile>): Promise<void> {
        const result = await this.showProfileEditModal(profile)
        if (!result) { return }

        await this.profilesService.writeProfile(result)
        await this.config.save()
    }

    async newProfile (): Promise<void> {
        const profiles = (await this.profilesService.getProfiles())
            .filter(x => !x.id || !this.config.store.profileBlacklist.includes(x.id))
        const base = await this.selector.show(
            this.translate.instant('Select a base profile to use as a template'),
            profiles.map(p => ({
                icon: p.icon ?? undefined,
                description: this.profilesService.getDescription(p) ?? undefined,
                name: p.group ? `${this.profilesService.resolveProfileGroupName(p.group)} / ${p.name}` : p.name,
                group: p.isTemplate ? this.translate.instant('Template') : this.translate.instant('Duplicate an existing profile'),
                result: p,
                weight: p.isTemplate ? 0 : 1,
            })),
        ).catch(() => null)
        if (!base) { return }

        const baseProfile: PartialProfile<Profile> = deepClone(base)
        delete baseProfile.id
        if (base.isTemplate) {
            baseProfile.name = ''
        } else if (!base.isBuiltin) {
            baseProfile.name = this.translate.instant('{name} copy', base)
        }
        await this.createProfileFrom(baseProfile, this.translate.instant('{name} copy', base))
    }

    async newProfileGroup (): Promise<void> {
        await this.editProfileGroup({
            id: 'new',
            name: '',
            icon: 'far fa-folder',
        })
    }

    async exportProfiles (): Promise<void> {
        const content = new TextEncoder().encode(JSON.stringify({
            version: 1,
            groups: this.config.store.groups,
            profiles: this.config.store.profiles,
        }, null, 4))
        const download = await this.platform.startDownload('tabby-connections.json', 0o600, content.length)
        if (download) {
            await download.write(content)
            download.close()
        }
    }

    async importProfiles (): Promise<void> {
        const uploads = await this.platform.startUpload({ multiple: false })
        if (!uploads.length) { return }

        let data: { groups?: PartialProfileGroup<ProfileGroup>[], profiles?: PartialProfile<Profile>[] } = {}
        try {
            data = JSON.parse(new TextDecoder().decode(await uploads[0].readAll()))
            if (!Array.isArray(data.profiles ?? []) || !Array.isArray(data.groups ?? [])) {
                throw new Error('"profiles" and "groups" must be arrays')
            }
        } catch (error) {
            await this.platform.showMessageBox({
                type: 'error',
                message: this.translate.instant('Could not import connections'),
                detail: String(error),
                buttons: [this.translate.instant('OK')],
            })
            return
        }

        // Entries with the same name as an existing one replace it (keeping the existing id)
        const groups = this.config.store.groups as PartialProfileGroup<ProfileGroup>[]
        const groupIds = new Map<string, string>()
        const importedGroups: PartialProfileGroup<ProfileGroup>[] = []
        for (const group of data.groups ?? []) {
            const index = groups.findIndex(g => g.name === group.name)
            if (index !== -1) {
                groupIds.set(group.id, groups[index].id)
                groups[index] = { ...group, id: groups[index].id }
                importedGroups.push(groups[index])
            } else {
                const fileId = group.id
                await this.profilesService.newProfileGroup(group, { genId: groups.some(g => g.id === group.id) })
                groupIds.set(fileId, group.id)
                importedGroups.push(group)
            }
        }
        for (const group of importedGroups) {
            if (group.parentGroupId) {
                group.parentGroupId = groupIds.get(group.parentGroupId) ?? group.parentGroupId
            }
        }

        const profiles = this.config.store.profiles as PartialProfile<Profile>[]
        let updated = 0
        for (const profile of data.profiles ?? []) {
            if (profile.group) {
                profile.group = groupIds.get(profile.group) ?? profile.group
            }
            const index = profiles.findIndex(p => p.name === profile.name)
            if (index !== -1) {
                profiles[index] = { ...profile, id: profiles[index].id }
                updated++
            } else {
                await this.profilesService.newProfile(profile, { genId: !profile.id || profiles.some(p => p.id === profile.id) })
            }
        }
        await this.config.save()

        const total = data.profiles?.length ?? 0
        this.notifications.info(this.translate.instant('Imported {total} connections ({updated} updated, {added} added)', { total, updated, added: total - updated }))
    }

    async cloneProfile (profile: PartialProfile<Profile>): Promise<void> {
        const baseProfile: PartialProfile<Profile> = deepClone(profile)
        delete baseProfile.id
        baseProfile.name = `copy-${profile.name}`
        await this.createProfileFrom(baseProfile, baseProfile.name)
    }

    async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete "{name}"?', profile),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response === 0) {
            await this.profilesService.deleteProfile(profile)
            this.config.store.profileFavorites = this.config.store.profileFavorites.filter(x => x !== profile.id)
            await this.config.save()
        }
    }

    async deleteProfileGroup (group: PartialProfileGroup<ProfileGroup>): Promise<void> {
        if ((await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete "{name}"?', group),
                buttons: [
                    this.translate.instant('Delete'),
                    this.translate.instant('Keep'),
                ],
                defaultId: 1,
                cancelId: 1,
            },
        )).response !== 0) {
            return
        }

        let deleteProfiles = false
        if ((group.profiles?.length ?? 0) > 0 && (await this.platform.showMessageBox(
            {
                type: 'warning',
                message: this.translate.instant('Delete the group\'s profiles?'),
                buttons: [
                    this.translate.instant('Move to "Ungrouped"'),
                    this.translate.instant('Delete'),
                ],
                defaultId: 0,
                cancelId: 0,
            },
        )).response !== 0) {
            deleteProfiles = true
        }

        if (deleteProfiles) {
            const deletedIds = this.config.store.profiles.filter(p => p.group === group.id).map(p => p.id)
            this.config.store.profileFavorites = this.config.store.profileFavorites.filter(x => !deletedIds.includes(x))
        }
        await this.profilesService.deleteProfileGroup(group, { deleteProfiles })
        await this.config.save()
    }

    private async createProfileFrom (baseProfile: PartialProfile<Profile>, fallbackName: string): Promise<void> {
        baseProfile.isBuiltin = false
        baseProfile.isTemplate = false

        const result = await this.showProfileEditModal(baseProfile)
        if (!result) { return }
        if (!result.name) {
            const cfgProxy = this.profilesService.getConfigProxyForProfile(result)
            result.name = this.profilesService.providerForProfile(result)?.getSuggestedName(cfgProxy) ?? fallbackName
        }
        await this.profilesService.newProfile(result)
        await this.config.save()
    }

    private async editProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const { EditProfileGroupModalComponent } = window['nodeRequire']('tabby-settings')

        const modal = this.ngbModal.open(
            EditProfileGroupModalComponent,
            { size: 'lg' },
        )

        modal.componentInstance.group = deepClone(group)
        modal.componentInstance.providers = this.profilesService.getProviders()

        const result: PartialProfileGroup<ProfileGroup & { group: PartialProfileGroup<CollapsableProfileGroup>, provider?: ProfileProvider<Profile> }> | null = await modal.result.catch(() => null)
        if (!result) { return }
        if (!result.group) { return }

        if (result.provider) {
            return this.editProfileGroupDefaults(result.group, result.provider)
        }

        delete result.group.collapsed
        delete result.group.children
        await this.profilesService.writeProfileGroup(result.group)
        await this.config.save()
    }

    private async editProfileGroupDefaults (group: PartialProfileGroup<CollapsableProfileGroup>, provider: ProfileProvider<Profile>): Promise<void> {
        const { EditProfileModalComponent } = window['nodeRequire']('tabby-settings')

        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = group.defaults?.[provider.id] ?? {}
        model.type = provider.id
        modal.componentInstance.profile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'group'

        const result = await modal.result.catch(() => null)
        if (result) {
            // Fully replace the config
            for (const k in model) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete model[k]
            }
            Object.assign(model, result)
            if (!group.defaults) {
                group.defaults = {}
            }
            group.defaults[provider.id] = model
        }
        return this.editProfileGroup(group)
    }

    async profileContextMenu (profile: PartialProfile<Profile>, event: MouseEvent): Promise<void> {
        event.preventDefault()

        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: this.translate.instant('Run'),
                click: () => this.launchProfile(profile),
            },
            {
                type: 'normal',
                label: this.translate.instant('Edit profile'),
                click: () => this.editProfile(profile),
                enabled: !(profile.isBuiltin ?? profile.isTemplate),
            },
            {
                type: 'normal',
                label: this.isFavorite(profile) ? this.translate.instant('Remove from favorites') : this.translate.instant('Add to favorites'),
                click: () => this.toggleFavorite(profile),
                enabled: !!profile.id,
            },
            {
                type: 'normal',
                label: this.translate.instant('Clone'),
                click: () => this.cloneProfile(profile),
            },
            {
                type: 'normal',
                label: this.translate.instant('Delete'),
                click: () => this.deleteProfile(profile),
                enabled: !(profile.isBuiltin ?? profile.isTemplate),
            },
        ])
    }

    async groupContextMenu (group: PartialProfileGroup<CollapsableProfileGroup>, event: MouseEvent): Promise<void> {
        event.preventDefault()
        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: group.collapsed ? this.translate.instant('Expand group') : this.translate.instant('Collapse group'),
                click: () => this.toggleGroupCollapse(group),
            },
            {
                type: 'normal',
                label: this.translate.instant('Edit group'),
                click: () => this.editProfileGroup(group),
                enabled: group.editable,
            },
            {
                type: 'normal',
                label: this.translate.instant('Delete group'),
                click: () => this.deleteProfileGroup(group),
                enabled: group.editable,
            },
        ])
    }

    private async tabStateChanged (): Promise<void> {
        // TODO: show active tab in the side panel with eye icon
    }

    async launchProfile<P extends Profile> (profile: PartialProfile<P>): Promise<any> {
        return this.profilesService.launchProfile(profile)
    }

    async onFilterChange (): Promise<void> {
        try {
            const q = this.filter.trim().toLowerCase()

            if (q.length === 0) {
                this.rootGroups = this.buildRootGroups()
                return
            }

            const profiles = await this.profilesService.getProfiles({
                includeBuiltin: this.config.store.terminal.showBuiltinProfiles,
                clone: true,
            })

            const matches = new FuzzySearch(
                profiles.filter(p => !p.isTemplate),
                ['name', 'description'],
                { sort: false },
            ).search(q)

            this.rootGroups = [
                {
                    id: 'search',
                    editable: false,
                    name: this.translate.instant('Filter results'),
                    icon: 'fas fa-magnifying-glass',
                    profiles: matches,
                },
            ]
        } catch (error) {
            console.error('Error occurred during search:', error)
        }
    }

    ////// RESIZING //////
    startResize (event: MouseEvent): void {
        this.panelIsResizing = true
        this.panelStartX = event.clientX
        this.panelStartWidth = this.panelWidth
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.panelIsResizing) { return }
        const delta = event.clientX - this.panelStartX
        const width = Math.min(Math.max(this.panelMinWidth, this.panelStartWidth + delta), this.panelMaxWidth)
        this.panelWidth = width
        window.localStorage.profileTreeWidth = width
    }

    @HostListener('document:mouseup')
    stopResize (): boolean {
        this.panelIsResizing = false
        return true
    }

    @HostBinding('style.width.px')
    get panelWidth (): number {
        return this.panelInternalWidth
    }

    set panelWidth (value: number) {
        this.panelInternalWidth = value
    }

    ////// GROUP COLLAPSING //////
    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        this.saveProfileGroupCollapse(group)
    }

    private saveProfileGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        const collapsableGroup = {
            ...group,
            collapsed,
        }
        return collapsableGroup
    }

}
