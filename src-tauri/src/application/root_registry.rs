//! Own registered workspaces and route only explicitly captured root incarnations.
use crate::application::workspace::Workspace;
use crate::contracts::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct RootRegistry {
    roots: BTreeMap<RootId, Workspace>,
}

impl RootRegistry {
    /// List every registered root incarnation in stable identifier order.
    pub fn list(&self) -> Vec<WorkspaceInfo> {
        self.roots
            .values()
            .map(|workspace| workspace.info())
            .collect()
    }

    /// Reject a duplicate or nested canonical root, including alias targets.
    fn reject_nested(&self, workspace: &Workspace) -> Result<(), WorkspaceError> {
        for existing in self.roots.values() {
            if existing.root() == workspace.root() {
                return Err(WorkspaceError::AlreadyExists);
            }
            if workspace.root().starts_with(existing.root())
                || existing.root().starts_with(workspace.root())
            {
                return Err(WorkspaceError::OutsideWorkspace);
            }
        }
        Ok(())
    }

    /// Add one independent root while keeping existing documents and buffers.
    pub fn add(&mut self, workspace: Workspace) -> Result<WorkspaceInfo, WorkspaceError> {
        self.reject_nested(&workspace)?;
        self.register(workspace)
    }

    /// Remove one root incarnation, refusing when its own buffers stay dirty.
    pub fn remove(&mut self, scope: &RootScope) -> Result<WorkspaceInfo, WorkspaceError> {
        let info = {
            let workspace = self.workspace_mut(scope)?;
            workspace.ensure_clean()?;
            workspace.info()
        };
        self.roots.remove(&scope.root_id);
        Ok(info)
    }

    /// Save or discard a whole root only after every save succeeds, retaining all actors on failure.
    pub fn remove_with_decision(
        &mut self,
        scope: &RootScope,
        action: CloseAction,
    ) -> Result<Option<WorkspaceInfo>, WorkspaceError> {
        let workspace = self.workspace_mut(scope)?;
        if action == CloseAction::Cancel {
            return Ok(None);
        }
        let documents = workspace.documents()?;
        if action == CloseAction::Save {
            for document in &documents {
                let actor = workspace.actor(&document.snapshot.document_id.0)?;
                let snapshot = actor.sync_from_nvim()?;
                if snapshot.dirty {
                    actor.save(SaveRequest {
                        location: snapshot.location.clone(),
                        document_id: snapshot.document_id.clone(),
                        base_revision: snapshot.revision,
                    })?;
                }
            }
            workspace.ensure_clean()?;
        }
        // Do not close any actor before all fallible saves finish.
        for document in &documents {
            workspace
                .actor(&document.snapshot.document_id.0)?
                .discard_recovery()?;
        }
        let info = workspace.info();
        self.roots.remove(&scope.root_id);
        Ok(Some(info))
    }

    /// Register an already validated workspace without replacing another owner.
    pub fn register(&mut self, workspace: Workspace) -> Result<WorkspaceInfo, WorkspaceError> {
        let info = workspace.info();
        if self.roots.contains_key(&info.scope.root_id) {
            return Err(WorkspaceError::AlreadyExists);
        }
        for document in workspace.documents()? {
            if self
                .roots
                .values()
                .any(|root| root.actor(&document.snapshot.document_id.0).is_ok())
            {
                return Err(WorkspaceError::AlreadyExists);
            }
        }
        self.roots.insert(info.scope.root_id.clone(), workspace);
        Ok(info)
    }

    /// Preserve unsaved working copies in recovery before replacing the active workspace.
    pub fn replace(&mut self, workspace: Workspace) -> Result<WorkspaceInfo, WorkspaceError> {
        for previous in self.roots.values() {
            previous.checkpoint_all()?;
        }
        if let Some(previous) = self.roots.get(&workspace.scope().root_id) {
            if previous.root() != workspace.root() {
                return Err(WorkspaceError::WrongOwner);
            }
        }
        let info = workspace.info();
        self.roots.clear();
        self.roots.insert(info.scope.root_id.clone(), workspace);
        Ok(info)
    }

    /// Refuse root replacement while any owned buffer has unsaved changes.
    pub fn ensure_clean(&self) -> Result<(), WorkspaceError> {
        for workspace in self.roots.values() {
            workspace.ensure_clean()?;
        }
        Ok(())
    }

    /// Resolve an exact root incarnation; never fall back to the active UI folder.
    pub fn workspace_mut(&mut self, scope: &RootScope) -> Result<&mut Workspace, WorkspaceError> {
        let workspace = self
            .roots
            .get_mut(&scope.root_id)
            .ok_or(WorkspaceError::UnknownRoot)?;
        if workspace.scope() != scope {
            return Err(WorkspaceError::StaleRoot);
        }
        Ok(workspace)
    }

    /// Authorize the document owner and captured position before exposing its workspace.
    pub fn document_mut(
        &mut self,
        id: &str,
        location: &DocumentLocation,
    ) -> Result<&mut Workspace, WorkspaceError> {
        if self.roots.values().any(|workspace| {
            workspace.scope().root_id != location.scope.root_id && workspace.actor(id).is_ok()
        }) {
            return Err(WorkspaceError::WrongOwner);
        }
        let workspace = self.workspace_mut(&location.scope)?;
        workspace.validate_location(id, location)?;
        Ok(workspace)
    }

    /// Validate a recovery selection against its current root and recorded relative position.
    pub fn recovery_mut(
        &mut self,
        id: &str,
        location: &DocumentLocation,
    ) -> Result<&mut Workspace, WorkspaceError> {
        let workspace = self.workspace_mut(&location.scope)?;
        let entry = workspace
            .recovery_entries()?
            .into_iter()
            .find(|entry| entry.document_id.0 == id)
            .ok_or(WorkspaceError::NotFound)?;
        if entry.location != *location {
            return Err(WorkspaceError::StaleLocation);
        }
        Ok(workspace)
    }

    /// Poll all registered owners and retain each producing root incarnation.
    pub fn poll(&mut self) -> Vec<RootEvent> {
        self.roots
            .values_mut()
            .flat_map(|workspace| {
                let scope = workspace.scope().clone();
                workspace.poll().into_iter().map(move |event| RootEvent {
                    scope: scope.clone(),
                    event,
                })
            })
            .collect()
    }

    /// Report actual native connectivity across registered workspace owners.
    pub fn has_live_documents(&self) -> bool {
        self.roots.values().any(Workspace::has_live_documents)
    }
}
