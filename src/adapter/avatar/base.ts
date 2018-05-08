import { injectable, unmanaged } from 'inversify';
import { IStateStore, IStateStoreFactory } from '../../application/types/stateStore';
import { IWorkspaceService } from '../../application/types/workspace';
import { IServiceContainer } from '../../ioc/types';
import { ActionedUser, Avatar } from '../../types';
import { GitOriginType } from '../repository/types';
import { IAvatarProvider } from './types';

type CachedAvatar = Avatar & { retry: boolean; dateTimeMs: number };
type CachedPromise = { dateTimeMs: number; promise: Promise<Avatar | undefined> };
@injectable()
export abstract class BaseAvatarProvider implements IAvatarProvider {
    protected readonly httpProxy: string;
    private readonly avatarStateStore: IStateStore;
    private readonly getAvatarPromises: Map<string, CachedPromise>;
    public constructor(protected serviceContainer: IServiceContainer, @unmanaged() private remoteRepoType: GitOriginType) {
        const workspace = this.serviceContainer.get<IWorkspaceService>(IWorkspaceService);
        this.httpProxy = workspace.getConfiguration('http').get('proxy', '');
        const stateStoreFactory = this.serviceContainer.get<IStateStoreFactory>(IStateStoreFactory);
        this.avatarStateStore = stateStoreFactory.createStore();
        this.getAvatarPromises = new Map<string, CachedPromise>();
    }
    public async getAvatar(user: ActionedUser): Promise<Avatar | undefined> {
        const key = `Git:Avatar:${user.name}:${user.email}`;
        const cachedInfo = this.avatarStateStore.has(key) ? await this.avatarStateStore.get<CachedAvatar>(key)! : undefined;
        const retry = cachedInfo && cachedInfo.retry && (cachedInfo.dateTimeMs + (60 * 60 * 1000) < new Date().getTime());
        if (!cachedInfo || retry) {
            try {
                // If we're in the process of getting the avatar for a user, then don't request it again.
                // This way we avoid multiple requests for the same user (minimize 403 errors).
                let cachedPromise: CachedPromise | undefined;
                if (this.getAvatarPromises.has(key)) {
                    cachedPromise = this.getAvatarPromises.get(key)!;
                    if (cachedPromise.dateTimeMs + (60 * 60 * 1000) < new Date().getTime()) {
                        this.getAvatarPromises.delete(key);
                        cachedPromise = undefined;
                    }
                }
                if (!cachedPromise) {
                    cachedPromise = { dateTimeMs: Date.now(), promise: this.getAvatarImplementation(user) };
                    this.getAvatarPromises.set(key, cachedPromise);
                }
                const avatar = await cachedPromise!.promise;
                // const avatar = await this.getAvatarImplementation(user);
                const url = avatar ? avatar.url : undefined;
                const avatarUrl = avatar ? avatar.avatarUrl : undefined;
                const dateTimeMs = new Date().getTime();
                // If we don't have any errors, then never retry to get avatar, even if it is null.
                await this.avatarStateStore.set<CachedAvatar>(key, { url, retry: false, avatarUrl, dateTimeMs, name: user.name, email: user.email });
            } catch (ex) {
                // If we have errors in retreivig the info, then we can retry later.
                const dateTimeMs = new Date().getTime();
                await this.avatarStateStore.set<CachedAvatar>(key, { url: undefined, retry: true, avatarUrl: undefined, dateTimeMs, name: user.name, email: user.email });
            }
        }

        const info = await this.avatarStateStore.get<Avatar>(key)!;
        return info && info.avatarUrl ? info : undefined;
    }
    public supported(remoteRepo: GitOriginType): boolean {
        return remoteRepo === this.remoteRepoType;
    }
    protected abstract getAvatarImplementation(user: ActionedUser): Promise<Avatar | undefined>;
}
